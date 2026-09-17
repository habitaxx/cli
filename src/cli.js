import os from 'node:os'

import {
  authFileExists,
  authFilePath,
  currentAuthorization,
  domainKey,
  loadAuthStore,
  publicAuthorization,
  updateAuthStore,
} from './auth-store.js'
import { openBrowser } from './browser.js'
import {
  HabitaxxHttpError,
  buildMultipart,
  callOpenApi,
  exchangeRuntimeToken,
  parseDataArgument,
  requestJson,
  validateBaseUrl,
} from './http.js'

const VERSION = '0.1.0'
const DEFAULT_PLATFORM_URL = 'https://platform.habitaxx.com'
const DEFAULT_API_BASE_URL = 'https://open-api.habitaxx.com/v1'
const DEFAULT_SCOPES = ['capabilities:read', 'tasks:write']

const HELP = `栖界开放平台 CLI

用法：
  habitaxx auth init [选项]             登录并授权当前设备
  habitaxx auth status [选项]           查看本地授权状态
  habitaxx auth logout [选项]           删除本地授权
  habitaxx request <方法> <路径> [选项] 通过 Runtime 调用开放 API
  habitaxx bird detect --file <图片>    调用鸟类识别能力
  habitaxx imu predict [选项]           调用智能项圈 IMU 行为预测能力

授权选项：
  --platform-url <url>      授权页面地址（默认 ${DEFAULT_PLATFORM_URL}）
  --platform-api-url <url>  控制面 API 地址（默认 <platform-url>/api/v1）
  --api-base-url <url>      开放 API 地址（默认 ${DEFAULT_API_BASE_URL}）
  --client-name <name>      授权页显示的客户端名称
  --device-name <name>      授权页显示的设备名称
  --scope <scope[,scope]>   申请权限，可重复
  --ability <key[,key]>     申请能力，可重复；不传表示全部能力
  --no-open                 不自动打开浏览器

通用授权选择：
  --domain <origin>         使用 auth.json 中指定域，例如 https://open-api.habitaxx.com
  --json                    输出不含秘密的 JSON
  --check                   auth status 在线校验凭据（默认仅检查本地文件）
  --all                     auth logout 删除全部域的本地凭据

request 选项：
  --data '<json>'           JSON 请求体；也支持 --data @payload.json
  --form 'name=value'       multipart 字段，可重复；文件使用 name=@/path/file
  --header 'Name: value'    自定义请求头，可重复
  --output <file>           将响应体保存到文件

imu predict 选项：
  --data '<json>'           包含 samples 数组及可选 top_k 的数据；支持 @file.json
  --device <device_id>      可选，按设备标识预测
  --top-k <num>             可选，返回置信度前 K 项（默认 5）

安全说明：
  API Key 仅保存在 ~/.habitaxx/auth.json（目录 0700，文件 0600）。
  Runtime Access Token 仅在单次命令内存中使用，不写入磁盘，也不会放进 URL。
`

function parseArgs(args, { values = [], booleans = [] } = {}) {
  const valueOptions = new Set(values)
  const booleanOptions = new Set(booleans)
  const options = new Map()
  const positionals = []

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (item === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (!item.startsWith('--')) {
      positionals.push(item)
      continue
    }

    const equals = item.indexOf('=')
    const name = equals > 0 ? item.slice(0, equals) : item
    if (booleanOptions.has(name)) {
      if (equals > 0) throw new Error(`${name} 不接受参数值`)
      options.set(name, true)
      continue
    }
    if (!valueOptions.has(name)) throw new Error(`未知选项：${name}`)

    const value = equals > 0 ? item.slice(equals + 1) : args[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
    const existing = options.get(name)
    options.set(name, existing === undefined ? value : [...asArray(existing), value])
  }

  return { options, positionals }
}

function asArray(value) {
  return Array.isArray(value) ? value : [value]
}

function listOption(options, name, fallback = []) {
  if (!options.has(name)) return fallback
  const values = asArray(options.get(name))
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
  if (values.some((value) => !value)) throw new Error(`${name} 不能包含空权限或空能力标识`)
  return [...new Set(values)]
}

function stringOption(options, name, fallback) {
  const value = options.get(name)
  if (Array.isArray(value)) throw new Error(`${name} 只能指定一次`)
  return value === undefined ? fallback : String(value).trim()
}

function normalizeHttpUrl(value, optionName) {
  try {
    return validateBaseUrl(value)
  } catch {
    throw new Error(`${optionName} 必须是无凭据、query、fragment 的 HTTPS 地址（仅 loopback 允许 HTTP）`)
  }
}

function selectedDomain(options) {
  const explicitDomain = stringOption(options, '--domain', '')
  if (explicitDomain) return domainKey(normalizeHttpUrl(explicitDomain, '--domain'))
  const apiBaseUrl = stringOption(options, '--api-base-url', '')
  return apiBaseUrl ? domainKey(normalizeHttpUrl(apiBaseUrl, '--api-base-url')) : undefined
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, milliseconds)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function authInit(args) {
  const { options, positionals } = parseArgs(args, {
    values: [
      '--platform-url',
      '--platform-api-url',
      '--api-base-url',
      '--client-name',
      '--device-name',
      '--scope',
      '--ability',
    ],
    booleans: ['--no-open'],
  })
  if (positionals.length) throw new Error(`无法识别的参数：${positionals.join(' ')}`)

  const platformUrl = normalizeHttpUrl(
    stringOption(options, '--platform-url', process.env.HABITAXX_PLATFORM_URL || DEFAULT_PLATFORM_URL),
    '--platform-url',
  )
  const defaultApiUrl = `${platformUrl}/api/v1`
  const platformApiUrl = normalizeHttpUrl(
    stringOption(options, '--platform-api-url', process.env.HABITAXX_PLATFORM_API_URL || defaultApiUrl),
    '--platform-api-url',
  )
  const apiBaseUrl = normalizeHttpUrl(
    stringOption(options, '--api-base-url', process.env.HABITAXX_API_BASE_URL || DEFAULT_API_BASE_URL),
    '--api-base-url',
  )

  const requestedDomain = domainKey(apiBaseUrl)
  const existingStore = await loadAuthStore()
  if (existingStore.domains[requestedDomain]) {
    const existing = existingStore.domains[requestedDomain]
    throw new Error(
      `域 ${requestedDomain} 已存在授权（项目：${existing.project_name || existing.project_no}）。`
      + `若需重新授权，请先运行 habitaxx auth logout --domain ${requestedDomain}。`,
    )
  }

  const clientName = stringOption(options, '--client-name', 'Habitaxx CLI')
  const deviceName = stringOption(options, '--device-name', os.hostname() || 'developer-device')
  const scopes = listOption(options, '--scope', DEFAULT_SCOPES)
  const abilities = listOption(options, '--ability', [])

  const initResult = await requestJson(`${platformApiUrl}/device-auth/requests`, {
    method: 'POST',
    body: {
      client_name: clientName,
      device_name: deviceName,
      requested_scopes: scopes,
      requested_abilities: abilities,
      api_base_url: apiBaseUrl,
    },
  })

  const { device_code, user_code, verification_uri_complete, expires_in, interval = 5 } = initResult
  console.log(`\n请在浏览器中完成设备授权：\n  ${verification_uri_complete}\n`)
  console.log(`用户代码：${user_code}`)
  console.log(`有效时间：${Math.floor(expires_in / 60)} 分钟\n`)

  if (!options.has('--no-open')) {
    try {
      await openBrowser(verification_uri_complete)
      console.log('已尝试打开默认浏览器。如未打开，请手动复制上述链接。')
    } catch {
      console.log('未能自动打开浏览器，请手动复制上述链接完成授权。')
    }
  }

  console.log('等待授权中（按 Ctrl+C 可取消）...')
  const pollUrl = `${platformApiUrl}/device-auth/tokens`
  const pollIntervalMs = Math.max(interval, 2) * 1000
  const deadline = Date.now() + expires_in * 1000

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    try {
      const pollResult = await requestJson(pollUrl, {
        method: 'POST',
        body: { device_code },
      })
      if (pollResult && pollResult.api_key) {
        const stored = {
          domain: requestedDomain,
          api_base_url: apiBaseUrl,
          api_key: pollResult.api_key,
          api_key_prefix: pollResult.api_key_prefix || `${pollResult.api_key.slice(0, 12)}...`,
          project_id: pollResult.project_id,
          project_no: pollResult.project_no,
          project_name: pollResult.project_name,
          user_id: pollResult.user_id,
          capabilities: pollResult.capabilities || scopes,
          ability_keys: pollResult.ability_keys || abilities,
          authorized_at: new Date().toISOString(),
        }
        await updateAuthStore((store) => {
          store.domains[requestedDomain] = stored
          store.current = requestedDomain
        })
        console.log(`\n授权成功！项目：${stored.project_name}（${stored.project_no}）`)
        console.log(`凭据已安全保存至：${authFilePath()}`)
        return
      }
    } catch (err) {
      if (err instanceof HabitaxxHttpError) {
        if (err.code === 'AUTHORIZATION_PENDING') continue
        if (err.code === 'SLOW_DOWN') {
          await sleep(pollIntervalMs)
          continue
        }
      }
      throw err
    }
  }
  throw new Error('授权超时，请重新执行 habitaxx auth init')
}

async function authStatus(args) {
  const { options, positionals } = parseArgs(args, {
    values: ['--domain', '--api-base-url'],
    booleans: ['--json', '--check'],
  })
  if (positionals.length) throw new Error(`无法识别的参数：${positionals.join(' ')}`)
  const store = await loadAuthStore()
  const resolved = currentAuthorization(store, selectedDomain(options))

  let valid = null
  if (options.has('--check')) {
    try {
      await exchangeRuntimeToken(resolved.authorization)
      valid = true
    } catch (err) {
      valid = false
      if (!options.has('--json')) {
        console.warn(`警告：远程校验失败：${err.message}`)
      }
    }
  }

  const safe = publicAuthorization(resolved.authorization)
  if (options.has('--json')) {
    console.log(JSON.stringify({ ...safe, valid }, null, 2))
    return
  }

  console.log(`当前域：${safe.domain}`)
  console.log(`API 地址：${safe.api_base_url}`)
  console.log(`项目：${safe.project_name} (${safe.project_no})`)
  console.log(`API Key：${safe.api_key_prefix}`)
  console.log(`权限：${safe.capabilities.length ? safe.capabilities.join(', ') : '无'}`)
  console.log(`能力：${safe.ability_keys.length ? safe.ability_keys.join(', ') : '全部'}`)
  console.log(`授权时间：${safe.authorized_at}`)
  console.log(`凭据文件：${authFilePath()}`)
  if (valid !== null) console.log(`远程校验：${valid ? '有效' : '失败'}`)
}

async function authLogout(args) {
  const { options, positionals } = parseArgs(args, {
    values: ['--domain', '--api-base-url'],
    booleans: ['--all'],
  })
  if (positionals.length) throw new Error(`无法识别的参数：${positionals.join(' ')}`)
  if (!(await authFileExists())) {
    console.log('本地没有授权信息。')
    return
  }
  let removedDomain
  await updateAuthStore((store) => {
    if (options.has('--all')) {
      store.domains = {}
      store.current = null
    } else {
      const selected = currentAuthorization(store, selectedDomain(options))
      removedDomain = selected.domain
      delete store.domains[selected.domain]
      if (store.current === selected.domain) store.current = Object.keys(store.domains)[0] || null
    }
  })
  console.log(`已删除${removedDomain || '全部域'}的本地凭据。远程 API Key 未被撤销，请在开放平台中撤销。`)
}

function parseHeaders(values) {
  const headers = {}
  for (const value of values) {
    const separator = value.indexOf(':')
    if (separator <= 0) throw new Error(`无效的 --header 参数：${value}`)
    const name = value.slice(0, separator).trim()
    const headerValue = value.slice(separator + 1).trim()
    if (/^(authorization|x-api-key|host|proxy-authorization|cookie)$/i.test(name)) {
      throw new Error(`不允许通过 --header 覆盖 ${name}，认证由 CLI 安全管理`)
    }
    headers[name] = headerValue
  }
  return headers
}

async function resolveAuthorization(options) {
  const store = await loadAuthStore()
  return currentAuthorization(store, selectedDomain(options)).authorization
}

function printResponse(result) {
  if (result.output) {
    console.log(`响应已保存：${result.output}`)
    return
  }
  if (typeof result.body === 'string') {
    process.stdout.write(result.body.endsWith('\n') ? result.body : `${result.body}\n`)
    return
  }
  console.log(JSON.stringify(result.body, null, 2))
}

async function requestCommand(args) {
  const { options, positionals } = parseArgs(args, {
    values: ['--domain', '--api-base-url', '--data', '--form', '--header', '--output'],
  })
  if (positionals.length !== 2) throw new Error('用法：habitaxx request <方法> <路径> [选项]')
  if (options.has('--data') && options.has('--form')) throw new Error('--data 与 --form 不能同时使用')

  const [method, requestPath] = positionals
  const headers = parseHeaders(options.has('--header') ? asArray(options.get('--header')) : [])
  let body
  if (options.has('--data')) {
    const data = await parseDataArgument(stringOption(options, '--data', ''))
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(data)
  } else if (options.has('--form')) {
    body = await buildMultipart(asArray(options.get('--form')).map(String))
  }

  const authorization = await resolveAuthorization(options)
  const result = await callOpenApi(authorization, requestPath, {
    method,
    headers,
    body,
    output: stringOption(options, '--output', ''),
  })
  printResponse(result)
}

async function birdDetect(args) {
  const { options, positionals } = parseArgs(args, {
    values: ['--file', '--domain', '--api-base-url', '--output'],
  })
  if (positionals.length) throw new Error(`无法识别的参数：${positionals.join(' ')}`)
  const filePath = stringOption(options, '--file', '')
  if (!filePath) throw new Error('缺少 --file <图片路径>')

  const form = await buildMultipart([`file=@${filePath}`])
  const authorization = await resolveAuthorization(options)
  const result = await callOpenApi(authorization, '/bird/detect', {
    method: 'POST',
    body: form,
    output: stringOption(options, '--output', ''),
  })
  printResponse(result)
}

async function imuPredict(args) {
  const { options, positionals } = parseArgs(args, {
    values: ['--data', '--device', '--top-k', '--domain', '--api-base-url', '--output'],
  })
  if (positionals.length) throw new Error(`无法识别的参数：${positionals.join(' ')}`)
  const rawData = stringOption(options, '--data', '')
  if (!rawData) throw new Error('缺少 --data 参数（支持 JSON 字符串或 @文件路径）')

  const payload = await parseDataArgument(rawData)
  if (options.has('--top-k')) {
    payload.top_k = Number(stringOption(options, '--top-k', '5'))
  }

  const deviceId = stringOption(options, '--device', '')
  const path = deviceId ? `/imu/predict/${encodeURIComponent(deviceId)}` : '/imu/predict'

  const authorization = await resolveAuthorization(options)
  const result = await callOpenApi(authorization, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    output: stringOption(options, '--output', ''),
  })
  printResponse(result)
}

export async function main(args) {
  if (args.includes('--help') || args.includes('-h') || !args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(HELP)
    return
  }
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(VERSION)
    return
  }

  const [command, subcommand, ...rest] = args
  if (command === 'auth' && subcommand === 'init') return authInit(rest)
  if (command === 'auth' && subcommand === 'status') return authStatus(rest)
  if (command === 'auth' && subcommand === 'logout') return authLogout(rest)
  if (command === 'request') return requestCommand([subcommand, ...rest].filter((value) => value !== undefined))
  if (command === 'bird' && subcommand === 'detect') return birdDetect(rest)
  if (command === 'imu' && subcommand === 'predict') return imuPredict(rest)

  throw new Error(`未知命令：${args.join(' ')}\n\n${HELP}`)
}
