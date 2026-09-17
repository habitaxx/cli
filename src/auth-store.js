import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, rename, rm, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const FILE_VERSION = 1

export function authFilePath() {
  const override = process.env.HABITAXX_AUTH_FILE?.trim()
  const file = override ? path.resolve(override) : path.join(os.homedir(), '.habitaxx', 'auth.json')
  if (path.basename(path.dirname(file)) !== '.habitaxx') {
    throw new Error('HABITAXX_AUTH_FILE 必须位于独立的 .habitaxx 目录内，避免修改其他目录权限')
  }
  return file
}

export function domainKey(apiBaseUrl) {
  const url = new URL(apiBaseUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API 地址只支持 http 或 https')
  }
  return url.origin
}

function emptyAuthStore(deviceId = randomUUID()) {
  return {
    version: FILE_VERSION,
    device_id: deviceId,
    current: null,
    domains: {},
  }
}

async function rejectSymlink(target, kind) {
  try {
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) throw new Error(`${kind}不能是符号链接：${target}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function loadAuthStore({ allowMissing = true } = {}) {
  const file = authFilePath()
  await rejectSymlink(path.dirname(file), '授权目录')
  await rejectSymlink(file, '授权文件')

  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return emptyAuthStore()
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`授权文件格式损坏，请备份后删除并重新授权：${file}`)
  }
  if (parsed?.version !== FILE_VERSION || typeof parsed?.domains !== 'object' || !parsed.domains || Array.isArray(parsed.domains)) {
    throw new Error(`不支持的授权文件格式，请升级 CLI 或重新授权：${file}`)
  }
  for (const [domain, item] of Object.entries(parsed.domains)) {
    if (!item || typeof item.api_key !== 'string' || !item.api_key
        || typeof item.project_no !== 'string' || typeof item.user_id !== 'string'
        || !Array.isArray(item.capabilities) || !Array.isArray(item.ability_keys)
        || domainKey(item.api_base_url) !== domain) {
      throw new Error('授权文件包含无效的域信息，请备份后重新授权')
    }
  }
  if (typeof parsed.device_id !== 'string' || !parsed.device_id) parsed.device_id = randomUUID()
  return parsed
}

export async function saveAuthStore(store) {
  const file = authFilePath()
  const directory = path.dirname(file)
  await rejectSymlink(directory, '授权目录')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await rejectSymlink(file, '授权文件')

  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
    await chmod(file, 0o600)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
  return file
}

// 短期文件锁只覆盖读-改-写，不在等待浏览器授权期间持有。
export async function updateAuthStore(update) {
  const file = authFilePath()
  const directory = path.dirname(file)
  await rejectSymlink(directory, '授权目录')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const lockPath = `${file}.lock`
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`其他 CLI 正在更新授权文件；稍后重试。若进程异常退出，确认没有 CLI 运行后删除 ${lockPath}`)
    }
    throw error
  }
  try {
    const store = await loadAuthStore()
    await update(store)
    await saveAuthStore(store)
    return store
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

export function currentAuthorization(store, requestedDomain) {
  const key = requestedDomain || store.current
  if (!key || !store.domains[key]) {
    throw new Error('当前域尚未授权，请先运行 habitaxx auth init')
  }
  return { domain: key, authorization: store.domains[key] }
}

export function publicAuthorization(domain, authorization) {
  return {
    domain,
    platform_url: authorization.platform_url,
    platform_api_url: authorization.platform_api_url,
    api_base_url: authorization.api_base_url,
    project_id: authorization.project_id,
    project_no: authorization.project_no,
    project_name: authorization.project_name,
    user_id: authorization.user_id,
    api_key_id: authorization.api_key_id,
    api_key_name: authorization.api_key_name,
    api_key_prefix: authorization.api_key_prefix,
    capabilities: authorization.capabilities,
    ability_keys: authorization.ability_keys,
    authorized_at: authorization.authorized_at,
  }
}

export async function authFileExists() {
  try {
    await access(authFilePath(), fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}
