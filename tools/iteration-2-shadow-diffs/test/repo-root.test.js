'use strict'

// WP10-tests: the harness runs on `node --test`, the repository runs on jest. The repository's own
// `yarn test` must not try to pick these files up -- ts-jest would choke on plain CommonJS specs
// and the harness would fail a suite it is not part of.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, describe } = require('node:test')

const HARNESS = path.dirname(__dirname)
const REPO_ROOT = path.join(HARNESS, '..', '..')

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'))

describe('the repository test script leaves the harness alone', () => {
  test('the harness is not a yarn workspace of the repository', () => {
    const root = readJson(REPO_ROOT, 'package.json')
    for (const workspace of root.workspaces ?? []) {
      assert.doesNotMatch(workspace, /tools/, `workspace "${workspace}" would pull the harness into yarn test`)
      assert.doesNotMatch(workspace, /^\*+$/, `workspace "${workspace}" globs every directory`)
    }
  })

  test('the root jest run only projects into the two TypeScript workspaces', () => {
    const rootJest = require(path.join(REPO_ROOT, 'jest.config.js'))
    assert.ok(Array.isArray(rootJest.projects), 'the root jest config delegates to per-workspace projects')

    for (const project of rootJest.projects) {
      const relative = project.replace('<rootDir>/', '')
      const projectDir = path.resolve(REPO_ROOT, path.dirname(relative))
      // Anything the harness lives under would be an ancestor of the harness directory.
      assert.equal(
        path.relative(projectDir, HARNESS).startsWith('..'),
        true,
        `jest project "${project}" is an ancestor of the harness`
      )

      const config = require(path.resolve(REPO_ROOT, relative))
      assert.ok(Array.isArray(config.testMatch), `${project} declares testMatch`)
      for (const pattern of config.testMatch) {
        assert.match(pattern, /^<rootDir>\//, `${project} testMatch "${pattern}" must be anchored at its own rootDir`)
        assert.match(pattern, /\.spec\.ts$/, `${project} testMatch "${pattern}" must only take .spec.ts files`)
      }
    }
  })

  test('the harness specs are named so no jest testMatch in this repository can reach them', () => {
    const specs = fs.readdirSync(__dirname).filter((name) => name.endsWith('.js'))
    assert.ok(specs.length > 0)
    for (const spec of specs) {
      assert.match(spec, /\.test\.js$/, `${spec} must be a .test.js file, not a jest .spec.ts`)
    }
  })

  test('eslint skips the harness, so the repository lint script stays green', () => {
    const ignored = fs
      .readFileSync(path.join(REPO_ROOT, '.eslintignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
    // `*.js` at any depth: the harness is plain JavaScript and the repo config parses TypeScript
    // against tsconfig.json, which does not include tools/.
    assert.ok(ignored.includes('*.js'), '.eslintignore must keep plain .js out of the repository lint run')
  })
})
