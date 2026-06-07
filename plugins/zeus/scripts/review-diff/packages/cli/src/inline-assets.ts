// build.mjs の esbuild `define` で文字列定数として注入される、
// HTML に inline するべきアセット (marked / DOMPurify / クライアント React bundle)。
//
// なぜ types.ts と分けたか:
//   types.ts は client / server 両方から import されるが、ここで参照する __XXX__ は
//   CLI バンドル時にしか置換されない。client bundle (esbuild Step 1) で間違って参照すると
//   ReferenceError になるため、server-side 専用ファイルに隔離している。

declare const __MARKED_JS__: string | undefined
declare const __DOMPURIFY_JS__: string | undefined
declare const __CLIENT_JS__: string | undefined
declare const __CSS_STRING__: string | undefined

export const MARKED_JS: string =
  typeof __MARKED_JS__ === 'string' ? __MARKED_JS__ : ''
export const DOMPURIFY_JS: string =
  typeof __DOMPURIFY_JS__ === 'string' ? __DOMPURIFY_JS__ : ''
export const CLIENT_JS: string =
  typeof __CLIENT_JS__ === 'string' ? __CLIENT_JS__ : ''
export const CSS_STRING: string =
  typeof __CSS_STRING__ === 'string' ? __CSS_STRING__ : ''
