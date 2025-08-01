import path from 'node:path'
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Options } from 'sirv'
import sirv from 'sirv'
import type { Connect } from 'dep-types/connect'
import escapeHtml from 'escape-html'
import type { ViteDevServer } from '../../server'
import type { ResolvedConfig } from '../../config'
import { FS_PREFIX } from '../../constants'
import {
  fsPathFromUrl,
  isFileReadable,
  isImportRequest,
  isInternalRequest,
  isParentDirectory,
  isSameFilePath,
  normalizePath,
  removeLeadingSlash,
  urlRE,
} from '../../utils'
import {
  cleanUrl,
  isWindows,
  slash,
  withTrailingSlash,
} from '../../../shared/utils'

const knownJavascriptExtensionRE = /\.(?:[tj]sx?|[cm][tj]s)$/
const ERR_DENIED_FILE = 'ERR_DENIED_FILE'

const sirvOptions = ({
  config,
  getHeaders,
  disableFsServeCheck,
}: {
  config: ResolvedConfig
  getHeaders: () => OutgoingHttpHeaders | undefined
  disableFsServeCheck?: boolean
}): Options => {
  return {
    dev: true,
    etag: true,
    extensions: [],
    setHeaders(res, pathname) {
      // Matches js, jsx, ts, tsx, mts, mjs, cjs, cts, ctx, mtx
      // The reason this is done, is that the .ts and .mts file extensions are
      // reserved for the MIME type video/mp2t. In almost all cases, we can expect
      // these files to be TypeScript files, and for Vite to serve them with
      // this Content-Type.
      if (knownJavascriptExtensionRE.test(pathname)) {
        res.setHeader('Content-Type', 'text/javascript')
      }
      const headers = getHeaders()
      if (headers) {
        for (const name in headers) {
          res.setHeader(name, headers[name]!)
        }
      }
    },
    shouldServe: disableFsServeCheck
      ? undefined
      : (filePath) => {
          const servingAccessResult = checkLoadingAccess(config, filePath)
          if (servingAccessResult === 'denied') {
            const error: any = new Error('denied access')
            error.code = ERR_DENIED_FILE
            error.path = filePath
            throw error
          }
          if (servingAccessResult === 'fallback') {
            return false
          }
          servingAccessResult satisfies 'allowed'
          return true
        },
  }
}

export function servePublicMiddleware(
  server: ViteDevServer,
  publicFiles?: Set<string>,
): Connect.NextHandleFunction {
  const dir = server.config.publicDir
  const serve = sirv(
    dir,
    sirvOptions({
      config: server.config,
      getHeaders: () => server.config.server.headers,
      disableFsServeCheck: true,
    }),
  )

  const toFilePath = (url: string) => {
    let filePath = cleanUrl(url)
    if (filePath.indexOf('%') !== -1) {
      try {
        filePath = decodeURI(filePath)
      } catch {
        /* malform uri */
      }
    }
    return normalizePath(filePath)
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServePublicMiddleware(req, res, next) {
    // To avoid the performance impact of `existsSync` on every request, we check against an
    // in-memory set of known public files. This set is updated on restarts.
    // also skip import request and internal requests `/@fs/ /@vite-client` etc...
    if (
      (publicFiles && !publicFiles.has(toFilePath(req.url!))) ||
      isImportRequest(req.url!) ||
      isInternalRequest(req.url!) ||
      // for `/public-file.js?url` to be transformed
      urlRE.test(req.url!)
    ) {
      return next()
    }
    serve(req, res, next)
  }
}

export function serveStaticMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  const dir = server.config.root
  const serve = sirv(
    dir,
    sirvOptions({
      config: server.config,
      getHeaders: () => server.config.server.headers,
    }),
  )

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeStaticMiddleware(req, res, next) {
    // only serve the file if it's not an html request or ends with `/`
    // so that html requests can fallthrough to our html middleware for
    // special processing
    // also skip internal requests `/@fs/ /@vite-client` etc...
    const cleanedUrl = cleanUrl(req.url!)
    if (
      cleanedUrl.endsWith('/') ||
      path.extname(cleanedUrl) === '.html' ||
      isInternalRequest(req.url!) ||
      // skip url starting with // as these will be interpreted as
      // scheme relative URLs by new URL() and will not be a valid file path
      req.url?.startsWith('//')
    ) {
      return next()
    }

    const url = new URL(req.url!, 'http://example.com')
    const pathname = decodeURI(url.pathname)

    // apply aliases to static requests as well
    let redirectedPathname: string | undefined
    for (const { find, replacement } of server.config.resolve.alias) {
      const matches =
        typeof find === 'string'
          ? pathname.startsWith(find)
          : find.test(pathname)
      if (matches) {
        redirectedPathname = pathname.replace(find, replacement)
        break
      }
    }
    if (redirectedPathname) {
      // dir is pre-normalized to posix style
      if (redirectedPathname.startsWith(withTrailingSlash(dir))) {
        redirectedPathname = redirectedPathname.slice(dir.length)
      }
    }

    const resolvedPathname = redirectedPathname || pathname
    let fileUrl = path.resolve(dir, removeLeadingSlash(resolvedPathname))
    if (resolvedPathname.endsWith('/') && fileUrl[fileUrl.length - 1] !== '/') {
      fileUrl = withTrailingSlash(fileUrl)
    }
    if (redirectedPathname) {
      url.pathname = encodeURI(redirectedPathname)
      req.url = url.href.slice(url.origin.length)
    }

    try {
      serve(req, res, next)
    } catch (e) {
      if (e && 'code' in e && e.code === ERR_DENIED_FILE) {
        respondWithAccessDenied(e.path, server, res)
        return
      }
      throw e
    }
  }
}

export function serveRawFsMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  const serveFromRoot = sirv(
    '/',
    sirvOptions({
      config: server.config,
      getHeaders: () => server.config.server.headers,
    }),
  )

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeRawFsMiddleware(req, res, next) {
    // In some cases (e.g. linked monorepos) files outside of root will
    // reference assets that are also out of served root. In such cases
    // the paths are rewritten to `/@fs/` prefixed paths and must be served by
    // searching based from fs root.
    if (req.url!.startsWith(FS_PREFIX)) {
      const url = new URL(req.url!, 'http://example.com')
      const pathname = decodeURI(url.pathname)
      let newPathname = pathname.slice(FS_PREFIX.length)
      if (isWindows) newPathname = newPathname.replace(/^[A-Z]:/i, '')
      url.pathname = encodeURI(newPathname)
      req.url = url.href.slice(url.origin.length)

      try {
        serveFromRoot(req, res, next)
      } catch (e) {
        if (e && 'code' in e && e.code === ERR_DENIED_FILE) {
          respondWithAccessDenied(e.path, server, res)
          return
        }
        throw e
      }
    } else {
      next()
    }
  }
}

/**
 * Check if the url is allowed to be served, via the `server.fs` config.
 * @deprecated Use the `isFileLoadingAllowed` function instead.
 */
export function isFileServingAllowed(
  config: ResolvedConfig,
  url: string,
): boolean
export function isFileServingAllowed(
  url: string,
  server: ViteDevServer,
): boolean
export function isFileServingAllowed(
  configOrUrl: ResolvedConfig | string,
  urlOrServer: string | ViteDevServer,
): boolean {
  const config = (
    typeof urlOrServer === 'string' ? configOrUrl : urlOrServer.config
  ) as ResolvedConfig
  const url = (
    typeof urlOrServer === 'string' ? urlOrServer : configOrUrl
  ) as string

  if (!config.server.fs.strict) return true
  const filePath = fsPathFromUrl(url)
  return isFileLoadingAllowed(config, filePath)
}

/**
 * Warning: parameters are not validated, only works with normalized absolute paths
 *
 * @param targetPath - normalized absolute path
 * @param filePath - normalized absolute path
 */
function isFileInTargetPath(targetPath: string, filePath: string) {
  return (
    isSameFilePath(targetPath, filePath) ||
    isParentDirectory(targetPath, filePath)
  )
}

/**
 * Warning: parameters are not validated, only works with normalized absolute paths
 */
export function isFileLoadingAllowed(
  config: ResolvedConfig,
  filePath: string,
): boolean {
  const { fs } = config.server

  if (!fs.strict) return true

  if (config.fsDenyGlob(filePath)) return false

  if (config.safeModulePaths.has(filePath)) return true

  if (fs.allow.some((uri) => isFileInTargetPath(uri, filePath))) return true

  return false
}

export function checkLoadingAccess(
  config: ResolvedConfig,
  path: string,
): 'allowed' | 'denied' | 'fallback' {
  if (isFileLoadingAllowed(config, slash(path))) {
    return 'allowed'
  }
  if (isFileReadable(path)) {
    return 'denied'
  }
  // if the file doesn't exist, we shouldn't restrict this path as it can
  // be an API call. Middlewares would issue a 404 if the file isn't handled
  return 'fallback'
}

export function respondWithAccessDenied(
  id: string,
  server: ViteDevServer,
  res: ServerResponse,
): void {
  const urlMessage = `The request id "${id}" is outside of Vite serving allow list.`
  const hintMessage = `
${server.config.server.fs.allow.map((i) => `- ${i}`).join('\n')}

Refer to docs https://vite.dev/config/server-options.html#server-fs-allow for configurations and more details.`

  server.config.logger.error(urlMessage)
  server.config.logger.warnOnce(hintMessage + '\n')
  res.statusCode = 403
  res.write(renderRestrictedErrorHTML(urlMessage + '\n' + hintMessage))
  res.end()
}

function renderRestrictedErrorHTML(msg: string): string {
  // to have syntax highlighting and autocompletion in IDE
  const html = String.raw
  return html`
    <body>
      <h1>403 Restricted</h1>
      <p>${escapeHtml(msg).replace(/\n/g, '<br/>')}</p>
      <style>
        body {
          padding: 1em 2em;
        }
      </style>
    </body>
  `
}
