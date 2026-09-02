#!/usr/bin/env node
'use strict'

/*
 * LOCAL TESTING ONLY - do not ship this directory with a template.
 *
 * integrator.io refuses to delete an integration while it still owns flows.
 * This deletes every flow belonging to one integration in a single run, and
 * optionally the integration itself, so a template install can be torn down
 * and reinstalled quickly.
 *
 * Dry run by default: nothing is deleted unless --confirm is passed.
 */

const REQUIRED_ENV_VARS = ['CELIGO_API_TOKEN']

const ENV_DEFAULTS = {
  CELIGO_API_BASE_URL: 'https://api.integrator.io',
  CELIGO_REQUEST_TIMEOUT_MS: '30000',
  CELIGO_DELETE_CONCURRENCY: '4',
  CELIGO_MAX_RETRIES: '3'
}

/*
 * Structured stdout logging in the same key=value shape the services use, so
 * output stays greppable. A standalone CLI has no @celigo/logger dependency.
 */
const logger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`)
}

class ConfigError extends Error {
  constructor (missing) {
    super(`Missing required environment variables: ${missing.join(', ')}`)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

class ApiError extends Error {
  constructor (message, statusCode) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}

/* Validates every required variable up front and fails fast, rather than
   surfacing a missing token on the first request. */
function loadConfig (env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name])

  if (missing.length > 0) {
    throw new ConfigError(missing)
  }
  return {
    apiToken: env.CELIGO_API_TOKEN,
    baseUrl: (env.CELIGO_API_BASE_URL || ENV_DEFAULTS.CELIGO_API_BASE_URL).replace(/\/+$/, ''),
    requestTimeoutMs: Number(env.CELIGO_REQUEST_TIMEOUT_MS || ENV_DEFAULTS.CELIGO_REQUEST_TIMEOUT_MS),
    concurrency: Number(env.CELIGO_DELETE_CONCURRENCY || ENV_DEFAULTS.CELIGO_DELETE_CONCURRENCY),
    maxRetries: Number(env.CELIGO_MAX_RETRIES || ENV_DEFAULTS.CELIGO_MAX_RETRIES)
  }
}

function parseArgs (argv) {
  const args = {
    integrationId: '',
    integrationName: '',
    confirm: false,
    deleteIntegration: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--integration-id') {
      args.integrationId = argv[++i] || ''
    } else if (arg === '--integration-name') {
      args.integrationName = argv[++i] || ''
    } else if (arg === '--confirm') {
      args.confirm = true
    } else if (arg === '--delete-integration') {
      args.deleteIntegration = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unrecognized argument: ${arg}`)
    }
  }
  if (!args.help && !args.integrationId && !args.integrationName) {
    throw new Error('Provide either --integration-id or --integration-name')
  }
  return args
}

function selectFlows (flows, integrationId) {
  return flows.filter((flow) => flow && flow._integrationId === integrationId)
}

function findIntegrationByName (integrations, name) {
  const matches = integrations.filter((integration) => integration && integration.name === name)

  if (matches.length === 0) {
    throw new Error(`No integration named "${name}"`)
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} integrations named "${name}"; rerun with --integration-id using one of: ` +
      matches.map((integration) => integration._id).join(', ')
    )
  }
  return matches[0]
}

function retryDelayMs (response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'))

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000
  }
  return 500 * Math.pow(2, attempt)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable (status) {
  return status === 429 || status >= 500
}

function createClient (config) {
  async function request (method, path) {
    let lastError

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      })

      if (response.ok) {
        return response.status === 204 ? null : response.json()
      }
      /* The response body can echo request context, so only the status is
         reported - never the token or the body. */
      lastError = new ApiError(`${method} ${path} failed`, response.status)
      if (!isRetryable(response.status) || attempt === config.maxRetries) {
        throw lastError
      }
      await sleep(retryDelayMs(response, attempt))
    }
    throw lastError
  }

  return {
    listFlows: () => request('GET', '/v1/flows'),
    listIntegrations: () => request('GET', '/v1/integrations'),
    deleteFlow: (id) => request('DELETE', `/v1/flows/${id}`),
    deleteIntegration: (id) => request('DELETE', `/v1/integrations/${id}`)
  }
}

/* Runs deletes in small batches so a large integration does not burst past the
   platform rate limit, and collects every failure instead of stopping at the
   first one. */
async function deleteFlows (client, flows, concurrency) {
  const deleted = []
  const failed = []

  for (let i = 0; i < flows.length; i += concurrency) {
    const batch = flows.slice(i, i + concurrency)

    await Promise.all(batch.map(async (flow) => {
      try {
        await client.deleteFlow(flow._id)
        deleted.push(flow)
        logger.info(`logName=flowDeleted, _flowId=${flow._id}, name=${flow.name}`)
      } catch (error) {
        failed.push({ flow, error })
        logger.error(
          `logName=flowDeleteFailed, _flowId=${flow._id}, name=${flow.name}, ` +
          `statusCode=${error.statusCode || 'UNKNOWN'}`
        )
      }
    }))
  }
  return { deleted, failed }
}

async function resolveIntegration (client, args) {
  if (args.integrationId) {
    return { _id: args.integrationId, name: args.integrationId }
  }
  const integrations = await client.listIntegrations()
  return findIntegrationByName(integrations, args.integrationName)
}

function printUsage () {
  logger.info(`
Delete every flow in one integration (local testing helper).

Usage:
  CELIGO_API_TOKEN=<token> node delete-all-flows.js --integration-name "<name>" [options]
  CELIGO_API_TOKEN=<token> node delete-all-flows.js --integration-id <24-char id> [options]

Options:
  --integration-id <id>      Target integration by id.
  --integration-name <name>  Target integration by exact name.
  --confirm                  Actually delete. Without this the run is a dry run.
  --delete-integration       Delete the integration once its flows are gone.
  -h, --help                 Show this message.

Environment:
  CELIGO_API_TOKEN           Required. API token from Resources > API Tokens.
  CELIGO_API_BASE_URL        Default ${ENV_DEFAULTS.CELIGO_API_BASE_URL} (use https://api.eu.integrator.io for EU).
  CELIGO_REQUEST_TIMEOUT_MS  Default ${ENV_DEFAULTS.CELIGO_REQUEST_TIMEOUT_MS}.
  CELIGO_DELETE_CONCURRENCY  Default ${ENV_DEFAULTS.CELIGO_DELETE_CONCURRENCY}.
  CELIGO_MAX_RETRIES         Default ${ENV_DEFAULTS.CELIGO_MAX_RETRIES}.
`)
}

async function main (argv, env) {
  const args = parseArgs(argv)

  if (args.help) {
    printUsage()
    return 0
  }

  const config = loadConfig(env)
  const client = createClient(config)
  const integration = await resolveIntegration(client, args)
  const flows = selectFlows(await client.listFlows(), integration._id)

  logger.info(
    `logName=flowsFound, _integrationId=${integration._id}, ` +
    `name=${integration.name}, flowCount=${flows.length}`
  )
  flows.forEach((flow) => logger.info(`  ${flow._id}  ${flow.name}`))

  if (!args.confirm) {
    logger.info(
      `logName=dryRun, flowCount=${flows.length}, ` +
      'message=nothing deleted; rerun with --confirm'
    )
    return 0
  }

  const { deleted, failed } = await deleteFlows(client, flows, config.concurrency)

  logger.info(
    `logName=flowDeleteSummary, _integrationId=${integration._id}, ` +
    `deleted=${deleted.length}, failed=${failed.length}`
  )
  if (failed.length > 0) {
    logger.error('logName=integrationNotDeleted, reason=flowDeletesFailed')
    return 1
  }
  if (args.deleteIntegration) {
    await client.deleteIntegration(integration._id)
    logger.info(`logName=integrationDeleted, _integrationId=${integration._id}`)
  }
  return 0
}

if (require.main === module) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof ConfigError) {
        error.missing.forEach((envVar) => {
          logger.error(`logName=requiredEnvVarMissing, envVar=${envVar}`)
        })
      } else {
        logger.error(
          `logName=deleteAllFlowsFailed, error=${error.message}, ` +
          `statusCode=${error.statusCode || 'UNKNOWN'}`
        )
      }
      process.exit(1)
    })
}

module.exports = {
  loadConfig,
  parseArgs,
  selectFlows,
  findIntegrationByName,
  deleteFlows,
  retryDelayMs,
  isRetryable,
  main,
  ConfigError,
  ApiError
}
