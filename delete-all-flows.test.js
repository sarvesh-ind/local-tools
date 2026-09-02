'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  loadConfig,
  parseArgs,
  selectFlows,
  findIntegrationByName,
  deleteFlows,
  retryDelayMs,
  isRetryable,
  ConfigError,
  ApiError
} = require('./delete-all-flows')

test('loadConfig reports every missing required variable', () => {
  assert.throws(() => loadConfig({}), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.deepStrictEqual(error.missing, ['CELIGO_API_TOKEN'])
    return true
  })
})

test('loadConfig applies defaults and trims the base url', () => {
  const config = loadConfig({ CELIGO_API_TOKEN: 'tok', CELIGO_API_BASE_URL: 'https://api.eu.integrator.io/' })

  assert.strictEqual(config.baseUrl, 'https://api.eu.integrator.io')
  assert.strictEqual(config.requestTimeoutMs, 30000)
  assert.strictEqual(config.concurrency, 4)
  assert.strictEqual(config.maxRetries, 3)
})

test('parseArgs defaults to a dry run', () => {
  const args = parseArgs(['--integration-id', '6a4f62c335f58cd73c4ac478'])

  assert.strictEqual(args.confirm, false)
  assert.strictEqual(args.deleteIntegration, false)
  assert.strictEqual(args.integrationId, '6a4f62c335f58cd73c4ac478')
})

test('parseArgs reads the delete flags', () => {
  const args = parseArgs(['--integration-name', 'Salesforce - NetSuite (Advanced)', '--confirm', '--delete-integration'])

  assert.strictEqual(args.integrationName, 'Salesforce - NetSuite (Advanced)')
  assert.strictEqual(args.confirm, true)
  assert.strictEqual(args.deleteIntegration, true)
})

test('parseArgs requires a target', () => {
  assert.throws(() => parseArgs([]), /--integration-id or --integration-name/)
})

test('parseArgs rejects unknown arguments', () => {
  assert.throws(() => parseArgs(['--wipe-everything']), /Unrecognized argument/)
})

test('parseArgs allows --help with no target', () => {
  assert.strictEqual(parseArgs(['--help']).help, true)
})

test('selectFlows keeps only flows owned by the integration', () => {
  const flows = [
    { _id: '1', _integrationId: 'a' },
    { _id: '2', _integrationId: 'b' },
    { _id: '3' },
    null
  ]

  assert.deepStrictEqual(selectFlows(flows, 'a').map((f) => f._id), ['1'])
})

test('findIntegrationByName rejects a missing name', () => {
  assert.throws(() => findIntegrationByName([{ name: 'other' }], 'missing'), /No integration named/)
})

test('findIntegrationByName rejects an ambiguous name', () => {
  const integrations = [{ _id: 'x', name: 'dup' }, { _id: 'y', name: 'dup' }]

  assert.throws(() => findIntegrationByName(integrations, 'dup'), /rerun with --integration-id/)
})

test('findIntegrationByName returns the single match', () => {
  assert.strictEqual(findIntegrationByName([{ _id: 'x', name: 'dup' }], 'dup')._id, 'x')
})

test('deleteFlows collects failures instead of stopping', async () => {
  const client = {
    deleteFlow: async (id) => {
      if (id === '2') {
        throw new ApiError('boom', 422)
      }
    }
  }
  const flows = [{ _id: '1', name: 'a' }, { _id: '2', name: 'b' }, { _id: '3', name: 'c' }]
  const result = await deleteFlows(client, flows, 2)

  assert.deepStrictEqual(result.deleted.map((f) => f._id).sort(), ['1', '3'])
  assert.strictEqual(result.failed.length, 1)
  assert.strictEqual(result.failed[0].error.statusCode, 422)
})

test('deleteFlows deletes every flow in one run', async () => {
  const seen = []
  const client = { deleteFlow: async (id) => { seen.push(id) } }
  const flows = Array.from({ length: 55 }, (_, i) => ({ _id: String(i), name: `flow ${i}` }))
  const result = await deleteFlows(client, flows, 4)

  assert.strictEqual(seen.length, 55)
  assert.strictEqual(result.deleted.length, 55)
  assert.strictEqual(result.failed.length, 0)
})

test('isRetryable covers throttling and server errors only', () => {
  assert.strictEqual(isRetryable(429), true)
  assert.strictEqual(isRetryable(503), true)
  assert.strictEqual(isRetryable(422), false)
  assert.strictEqual(isRetryable(404), false)
})

test('retryDelayMs honours Retry-After, else backs off', () => {
  const withHeader = { headers: new Map([['retry-after', '2']]) }
  withHeader.headers.get = (k) => new Map([['retry-after', '2']]).get(k)

  assert.strictEqual(retryDelayMs(withHeader, 0), 2000)
  assert.strictEqual(retryDelayMs({ headers: { get: () => null } }, 0), 500)
  assert.strictEqual(retryDelayMs({ headers: { get: () => null } }, 2), 2000)
})
