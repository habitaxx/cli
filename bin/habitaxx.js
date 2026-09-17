#!/usr/bin/env node

import { main } from '../src/cli.js'

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  const safe = message.replace(/qj_live_[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  console.error(`错误：${safe}`)
  process.exitCode = 1
})
