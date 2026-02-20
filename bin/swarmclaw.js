#!/usr/bin/env node
'use strict'

const { runCli } = require('../src/cli/index')

runCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
