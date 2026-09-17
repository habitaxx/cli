import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function validateBaseUrl(value) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('地址必须使用 HTTPS（本地 loopback 可用 HTTP），且不能含凭据、query 或 fragment')
  }
  return trimTrailingSlash(url.href)
}

function connectionError(error, url, method) {
  // 只展示公开地址和已知错误码，不输出请求头、请求体或 query 中的凭据。
  const target = new URL(url)
  const codes = [error?.code, error?.cause?.code,
    ...(error?.cause?.errors || []).map((item) => item?.code)]
  const reasons = {
    ECONNREFUSED: '连接被拒绝，请确认目标服务已启动，并检查监听地址和端口',
    ENOTFOUND: '域名解析失败，请检查地址和 DNS',
    EAI_AGAIN: '域名解析暂时失败，请检查网络和 DNS',
    ETIMEDOUT: '连接超时，请检查网络、防火墙和服务状态',
    UND_ERR_CONNECT_TIMEOUT: '连接超时，请检查网络、防火墙和服务状态',
    UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
    UND_ERR_BODY_TIMEOUT: '读取响应体超时',
    ECONNRESET: '连接被重置，请检查服务或代理日志',
    UND_ERR_SOCKET: '连接意外关闭，请检查服务或代理日志',
    CERT_HAS_EXPIRED: 'TLS 证书已过期，请检查服务器证书',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任，请检查服务器证书',
    EPERM: '当前进程无权访问目标地址，请检查系统或沙箱网络权限',
    EACCES: '当前进程无权访问目标地址，请检查系统或沙箱网络权限',
  }
  const code = codes.find((value) => Object.hasOwn(reasons, value))
  const reason = code ? `${reasons[code]}（${code}）`
    : '连接失败，请检查网络、TLS 证书或代理；CLI 不接受 HTTP 重定向'
  return new Error(`${method || 'GET'} ${target.origin}${target.pathname}：${reason}`, { cause: error })
}

async function boundedFetch(url, options, timeoutMs = 30000) {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  try {
    // 禁止重定向，尤其防止 X-API-Key 或设备凭证被带到其他域。
    const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal })
    // 在超时范围内读取响应体，而非只等待响应头。
    const bytes = await response.arrayBuffer()
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status, headers: response.headers,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      if (options.signal?.aborted) throw options.signal.reason || new Error('请求已取消')
      const target = new URL(url)
      throw new Error(`${options.method || 'GET'} ${target.origin}${target.pathname}：请求超时（${timeoutMs / 1000} 秒）`)
    }
    throw connectionError(error, url, options.method)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export class HabitaxxHttpError extends Error {
  constructor(message, { status, code, errorCode, callId, body } = {}) {
    super(message)
    this.name = 'HabitaxxHttpError'
    this.status = status
    this.code = code
    this.errorCode = errorCode
    this.callId = callId
    this.body = body
  }
}

export function trimTrailingSlash(value) {
  return value.trim().replace(/\/+$/, '')
}

export function unwrapPayload(value) {
  if (
    value
    && typeof value === 'object'
    && Object.hasOwn(value, 'code')
    && Object.hasOwn(value, 'message')
    && Object.hasOwn(value, 'data')
  ) {
    if (value.code !== 200 && value.code !== 0) {
      const msg = value.message || `业务请求失败（代码 ${value.code}）`
      throw new HabitaxxHttpError(msg, {
        status: 200,
        code: value.code,
        errorCode: value.error_code,
        callId: value.call_id,
        body: value,
      })
    }
    return value.data
  }
  return value
}

async function responseBody(response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }
  return response.text()
}

function errorMessage(response, body) {
  if (body && typeof body === 'object') {
    const message = body.message || body.detail || body.error
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300)
  return `请求失败（HTTP ${response.status}）`
}

export async function requestJson(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const response = await boundedFetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Client-Type': 'open_platform',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const parsed = await responseBody(response)
  if (!response.ok) {
    throw new HabitaxxHttpError(errorMessage(response, parsed), {
      status: response.status,
      code: parsed && typeof parsed === 'object' ? parsed.code : undefined,
      errorCode: parsed && typeof parsed === 'object' ? parsed.error_code : undefined,
      callId: parsed && typeof parsed === 'object' ? parsed.call_id : undefined,
      body: parsed,
    })
  }
  return unwrapPayload(parsed)
}

export async function exchangeRuntimeToken(authorization, { signal } = {}) {
  const result = await requestJson(`${validateBaseUrl(authorization.api_base_url)}/auth/token`, {
    method: 'POST',
    headers: { 'X-API-Key': authorization.api_key },
    body: {
      project_no: authorization.project_no,
      user_id: authorization.user_id,
    },
    signal,
  })
  if (!result?.access_token) throw new Error('平台未返回有效的 Runtime Access Token')
  return result
}

function safeApiUrl(apiBaseUrl, requestPath) {
  if (!requestPath || /^[a-z][a-z\d+.-]*:/i.test(requestPath) || requestPath.startsWith('//')) {
    throw new Error('请求路径必须是相对开放 API 根地址的路径，例如 /bird/detect')
  }
  const base = new URL(`${validateBaseUrl(apiBaseUrl)}/`)
  const target = new URL(requestPath.replace(/^\/+/, ''), base)
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.hash) {
    throw new Error('请求路径不能跳出开放 API 根地址')
  }
  return target.href
}

export async function callOpenApi(
  authorization,
  requestPath,
  { method = 'GET', headers = {}, body, output, signal } = {},
) {
  const url = safeApiUrl(authorization.api_base_url, requestPath)
  const token = await exchangeRuntimeToken(authorization, { signal })
  const response = await boundedFetch(url, {
    method: method.toUpperCase(),
    headers: {
      Accept: 'application/json',
      'X-Client-Type': 'open_platform',
      ...headers,
      Authorization: `Bearer ${token.access_token}`,
    },
    body,
    signal,
  }, 120000)

  const parsed = await responseBody(response)
  if (!response.ok) {
    throw new HabitaxxHttpError(errorMessage(response, parsed), {
      status: response.status,
      code: parsed && typeof parsed === 'object' ? parsed.code : undefined,
      errorCode: parsed && typeof parsed === 'object' ? parsed.error_code : undefined,
      callId: parsed && typeof parsed === 'object' ? parsed.call_id : undefined,
      body: parsed,
    })
  }

  // 检查业务层错误（统一 200 返回中 code != 200）
  if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'code') && parsed.code !== 200 && parsed.code !== 0) {
    const msg = parsed.message || `业务请求失败（代码 ${parsed.code}）`
    throw new HabitaxxHttpError(msg, {
      status: response.status,
      code: parsed.code,
      errorCode: parsed.error_code,
      callId: parsed.call_id,
      body: parsed,
    })
  }

  if (output) {
    const target = path.resolve(output)
    if (Buffer.isBuffer(parsed) || typeof parsed === 'string') {
      await writeFile(target, parsed)
    } else {
      await writeFile(target, JSON.stringify(parsed, null, 2))
    }
    return { output: target, status: response.status }
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body: parsed,
  }
}

export async function parseDataArgument(value) {
  const raw = value.startsWith('@')
    ? await readFile(path.resolve(value.slice(1)), 'utf8')
    : value
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('--data 必须是有效 JSON，或使用 @文件路径')
  }
}

const FILE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
}

export async function buildMultipart(entries) {
  const form = new FormData()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) throw new Error(`无效的 --form 参数：${entry}`)
    const name = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1)
    if (!name) throw new Error(`无效的 --form 参数：${entry}`)
    if (value.startsWith('@')) {
      const filePath = path.resolve(value.slice(1))
      const bytes = await readFile(filePath)
      // 文件部分需要自己的 MIME 类型；外层 multipart boundary 仍由 fetch 生成。
      const type = FILE_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      form.append(name, new Blob([bytes], { type }), path.basename(filePath))
    } else {
      form.append(name, value)
    }
  }
  return form
}
