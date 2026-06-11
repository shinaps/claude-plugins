// 1 グループの左 sticky ペイン (stacked group モデル)。
//
// 構成方針:
//   - Reviewed progress meter は廃止 (panel 単位 Reviewed 概念ごと撤廃)
//   - 代わりに group ヘッダ右隅に decision バッジ (APPROVED / CHANGES / NO PANELS) を表示
//   - panel list の下に「decision section」を配置: group コメント textarea + Approve / Request Changes
//     ボタンを colocate。ユーザーは「左で評価 / 右で読む」レイアウトで decision を完結できる
//   - context+ ボタンは close-relaunch ループの起点として regen-group を発火
//
// 構成 (上から):
//   1. eyebrow: GROUP の小さなラベル + 右上に display number "01/04" + decision バッジ
//   2. title (h2): tight tracking、emphasized
//   3. description (markdown): 控えめ、余白多め
//   4. context+ button: アイコン主体の Linear 風 pill
//   5. panel list: 各 item に dot indicator (active rail = currently-reading 強調)
//   6. decision section: textarea + Approve / Request Changes (panels=0 group は disable)
//
// scroll spy:
//   IntersectionObserver で .panel-block の可視性を観測し、いま画面に最も上に
//   見えている panel を active 表示する。

import { useEffect, useState } from 'react'
import { Plus, LoaderCircle, ChevronUp, ChevronDown, MessageSquare, X, Check } from 'lucide-react'
import type { RenderedPanel, GroupDecision, ThreadSnapshot } from '@zeus/review-diff-shared'
import { renderMarkdown } from '../lib/markdown'
import { basename } from '../lib/path'
import { cssEscape } from '../lib/css-escape'

type Props = {
  index: number
  total: number
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
  onJumpToPanel: (panelId: string) => void
  // context+ (close-relaunch): regen 中は全 group の context+ ボタンを止める。
  // note: 任意の自由文。「どの context を追加してほしいか」を AI に伝える。
  regenPending: boolean
  onRequestContext: (groupId: string, note?: string) => void
  // group decision + comment
  decision: GroupDecision | null
  comment: string
  // この group を anchor にした会話スレッド。Comment で送った group コメントに
  // Claude が返信すると comment-reply 復帰時にここへ載り、「質問した場所」で会話が読める。
  thread: ThreadSnapshot | null
  onDecisionChange: (groupId: string, next: GroupDecision | null) => void
  onCommentChange: (groupId: string, body: string) => void
  // group コメントをこの group のスレッドに「積む」(GitHub の pending review コメントと同じ感覚)。
  // 即時送信はせずレビューを継続でき、Claude への送信は SubmitBar の Comment / Submit に同乗する。
  onSubmitComment: (groupId: string) => void
  // regen 中など、Approve/RC ボタンも操作不可にしたい時 true
  submitDisabled: boolean
  // グループ間ナビゲーション。eyebrow の数字横に prev/next 矢印を出して
  // 「次の group へスクロール」をワンクリックでできるようにする。先頭/末尾 group では片側 disabled。
  onJumpToGroupIndex: (targetIndex: number) => void
}

export function GroupNav({
  index, total, groupId, title, description, panels, onJumpToPanel,
  regenPending, onRequestContext,
  decision, comment, thread, onDecisionChange, onCommentChange, onSubmitComment, submitDisabled,
  onJumpToGroupIndex,
}: Props) {
  // eyebrow に "01/04" のようなゼロ埋め 2 桁で表示するためのラベル文字列
  const groupIndexLabel = String(index + 1).padStart(2, '0')
  const totalGroupsLabel = String(total).padStart(2, '0')
  const descHtml = renderMarkdown(description || '')

  const activePanelId = useScrollSpy(panels)
  const noPanels = panels.length === 0

  // context+ inline textarea の開閉状態と入力中の note。
  // expand=false: + ボタンだけ。expand=true: textarea + Cancel / Send ボタン。
  // note は空でも submit 可能 (= 旧挙動の「range だけ広げる」と同等)。
  const [ctxExpanded, setCtxExpanded] = useState(false)
  const [ctxNote, setCtxNote] = useState('')
  // regenPending が立つ (= 別 group で context+ 発火) と全 group の context+ が止まるので、
  // 開いていた textarea も閉じて UI を整合させる。
  useEffect(() => {
    if (regenPending) {
      setCtxExpanded(false)
      setCtxNote('')
    }
  }, [regenPending])
  function sendCtx() {
    const note = ctxNote.trim()
    setCtxExpanded(false)
    setCtxNote('')
    onRequestContext(groupId, note || undefined)
  }
  function cancelCtx() {
    setCtxExpanded(false)
    setCtxNote('')
  }

  // decision バッジのラベルとクラス。panels=0 の group は強制 approved 扱いだが
  // バッジ表記は「NO PANELS」として区別する (Submit active 条件は満たすが UI 上は明示)。
  const badge = noPanels
    ? { label: 'NO PANELS', cls: 'is-no-panels' }
    : decision === 'approved'
      ? { label: 'APPROVED', cls: 'is-approved' }
      : decision === 'request-changes'
        ? { label: 'CHANGES', cls: 'is-rc' }
        : null

  const decisionInteractive = !noPanels && !submitDisabled

  // jump-btn の utility 文字列。先頭/末尾で disabled になるため `enabled:hover:*` で切り分け。
  const JUMP_BTN =
    'bg-transparent border border-border-soft text-text-dim w-[22px] h-[22px] rounded-[5px] inline-flex items-center justify-center cursor-pointer p-0 transition-colors duration-[120ms] enabled:hover:bg-surface-2 enabled:hover:text-text enabled:hover:border-border disabled:opacity-[0.35] disabled:cursor-not-allowed'

  return (
    // sticky で section 内に追従、最大高は viewport-96px。decision section を mt-auto で
    // 末尾に貼り付けるため flex-col。1000px 以下では grid 解除 (globals.css の .group-section
    // media query) に合わせて static に落とす。scrollbar は細い 4px の縦バー。
    <aside className="sticky top-16 self-start max-h-[calc(100vh-96px)] overflow-y-auto pr-2 flex flex-col max-[1000px]:static max-[1000px]:max-h-none [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-[2px]">
      <header className="pb-[18px] mb-[18px] border-b border-border-soft">
        <div className="flex items-center justify-between mb-3.5 min-h-6">
          <span className="font-mono text-3xs font-semibold tracking-[0.18em] text-text-dim uppercase">GROUP</span>
          <span
            className="inline-flex items-baseline font-mono tabular-nums text-text-dim tracking-tight"
            aria-label={`Group ${index + 1} of ${total}`}
          >
            <span className="text-lg font-semibold text-text">{groupIndexLabel}</span>
            <span className="text-sm mx-[3px] text-text-dim opacity-60">/</span>
            <span className="text-sm text-text-dim">{totalGroupsLabel}</span>
          </span>
          {/* グループ間ナビゲーション。
              eyebrow 直後に prev/next 矢印を置いて scroll を 1 click でやれるようにする。
              先頭/末尾の group では片側を disabled (cursor not-allowed + opacity 落とし)。 */}
          <div className="inline-flex gap-0.5 ml-auto items-center" role="group" aria-label="Jump between groups">
            <button
              type="button"
              className={JUMP_BTN}
              onClick={() => onJumpToGroupIndex(index - 1)}
              disabled={index === 0}
              aria-label="Previous group"
              title="前のグループへ"
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              className={JUMP_BTN}
              onClick={() => onJumpToGroupIndex(index + 1)}
              disabled={index === total - 1}
              aria-label="Next group"
              title="次のグループへ"
            >
              <ChevronDownIcon />
            </button>
          </div>
          {badge ? (
            // group-decision-badge BEM 維持: is-approved/is-rc/is-no-panels の色切替が globals.css にあるため
            <span
              className={`group-decision-badge inline-flex items-center px-2 py-0.5 ml-1.5 text-3xs font-semibold tracking-[0.06em] uppercase rounded-full border border-transparent ${badge.cls}`}
              aria-label={`Decision: ${badge.label}`}
            >
              {badge.label}
            </span>
          ) : null}
        </div>
        <h2 className="text-base font-semibold text-text m-0 mb-2.5 tracking-[-0.015em] leading-[1.25]">{title}</h2>
        {descHtml ? (
          // group-desc BEM 維持: prose 内 typography token の上書き scope として globals.css で使用。
          <div
            className="group-desc prose prose-invert prose-sm max-w-none text-xs leading-[1.55] mb-4"
            dangerouslySetInnerHTML={{ __html: descHtml }}
          />
        ) : null}
      </header>

      {/* context+ は close-relaunch ループの起点。クリックで現状 state を回収して
          CLI を終了させ、SKILL.md 側で summary.json を再生成してから Skill を再起動する。
          regenPending=true 中は他 group も含め全ての context+ を disable する。
          クリックで inline textarea が開き、「どの context を追加してほしいか」を自由文で
          AI に伝えられる (空文字なら旧挙動 = range +5〜10 行拡張だけ)。 */}
      <div className="mb-4" role="group" aria-label="Request more context">
        {!ctxExpanded ? (
          <div className="flex justify-start">
            {/* btn-context BEM 維持: .is-pending state による accent 色化が globals.css にあるため。
                base 見た目は utility。spinner は lucide LoaderCircle + animate-spin。 */}
            <button
              type="button"
              className={`btn-context inline-flex items-center gap-2 px-3 py-[7px] text-xs font-medium font-sans tracking-[-0.005em] text-text bg-surface-2 border border-border-soft rounded-md cursor-pointer shadow-[0_1px_0_rgba(0,0,0,0.2)] transition-[background,border,color,transform] duration-[120ms] enabled:hover:bg-surface-3 enabled:hover:border-border enabled:hover:text-text enabled:active:translate-y-[0.5px] focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-[0.45] disabled:cursor-not-allowed disabled:bg-transparent${regenPending ? ' is-pending' : ''}`}
              disabled={regenPending}
              title={
                regenPending
                  ? 'Regenerating — this tab will close and reopen automatically'
                  : 'Request more context (textarea が開きます)'
              }
              onClick={() => setCtxExpanded(true)}
              aria-busy={regenPending}
              aria-expanded={false}
            >
              <span className="inline-flex items-center w-3 h-3" aria-hidden="true">
                {regenPending ? <SpinnerIcon /> : <PlusIcon />}
              </span>
              <span className="tabular-nums">
                {regenPending ? 'Regenerating' : 'More context'}
              </span>
            </button>
          </div>
        ) : (
          // expanded: textarea + Cancel / Send。空文字でも Send 可 (= 旧挙動の range +5〜10 行拡張だけ)。
          <div className="flex flex-col gap-2 p-2.5 bg-surface-2 border border-border-soft rounded-md">
            <textarea
              autoFocus
              value={ctxNote}
              onChange={(e) => setCtxNote(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter で送信、Esc でキャンセル (CommentForm と同じ規約)
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  sendCtx()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelCtx()
                }
              }}
              placeholder="どの context を追加してほしいか (任意。例: 「foo() の caller も見たい」「呼び出しチェーン全部」)"
              rows={3}
              className="w-full min-h-[60px] resize-none bg-background text-text border border-border rounded-md px-2.5 py-2 font-sans text-xs leading-[1.5] outline-none transition-colors duration-100 focus:border-accent"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                className="px-3 py-1 border border-border rounded-md text-xs font-medium font-sans cursor-pointer bg-transparent text-text-muted hover:bg-surface-3 hover:text-text transition-colors duration-100"
                onClick={cancelCtx}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1 border border-accent bg-accent rounded-md text-xs font-medium font-sans cursor-pointer text-white hover:brightness-[1.08] transition-[filter,background] duration-100 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={regenPending}
                onClick={sendCtx}
                title={ctxNote.trim() ? 'Submit with note' : 'Submit without note (= range expansion only)'}
              >
                Submit context+
              </button>
            </div>
          </div>
        )}
      </div>

      {panels.length ? (
        // group-panel-list の `margin-left: -2px + padding-left: 2px` は active rail (::before) を
        // nav 左端ぴったりに見せるためのオフセット。utility 化可能だがセマンティック wrap で残置。
        <nav className="flex flex-col gap-px -ml-0.5 pl-0.5" aria-label="Panels in this group">
          {panels.map((p) => (
            <PanelItem
              key={p.panelId}
              panel={p}
              active={activePanelId === p.panelId}
              onJump={onJumpToPanel}
            />
          ))}
        </nav>
      ) : null}

      {/* decision section: panels=0 の group は disable + no-panels 表示
          (ユーザーは何を見ずに decide するのかわからないので、自動 approved 扱いを App 側で行う) */}
      {/* group-decision-section BEM の `margin-top: auto` は flex column 親 (.group-nav) で必要だったが、
          ここでは utility `mt-auto` で代替する。残りは utility 化。 */}
      <div className="mt-auto pt-4 border-t border-border-soft flex flex-col gap-2.5">
        {/* group スレッドの会話履歴 (pending で積んだ自分のコメント + Claude の返信)。
            Activity タブの Conversation にも出るが、「質問を書いた場所で返信が読める」ことを優先して
            ここにも compact 表示する。追記は下の textarea に書いて Comment (= 同じ thread に積まれる)。 */}
        {thread && thread.messages.length > 0 ? (
          /* 高さ制限なしの全文表示: group スレッドは数往復程度の想定で、
             max-height + スクロールにすると読み返しの体験が悪い */
          <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft bg-surface px-2.5 py-2">
            {/* 最後の message が Claude の返信なら新着としてパルスで注目喚起する (review スレッドと同じ視覚言語) */}
            {thread.messages.map((m, i) => (
              <div
                key={m.id}
                className={`flex flex-col gap-0.5 px-1 -mx-1${
                  m.author === 'agent' && i === thread.messages.length - 1 ? ' thread-new-message' : ''
                }`}
              >
                <span className={`text-3xs font-semibold tracking-[0.05em] uppercase ${m.author === 'agent' ? 'text-accent' : 'text-text-dim'}`}>
                  {m.author === 'agent' ? 'Claude' : 'You'}
                </span>
                <p className="m-0 text-sm leading-[1.55] text-text whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            ))}
          </div>
        ) : null}
        {/* field-sizing: content (Chrome 123+) で textarea を content 量に合わせて自動拡張。
            JS で scrollHeight を測る古典的 auto-resize より軽量、対応ブラウザでは scrollbar も出ない。
            overflow-y-auto 併用: 非対応ブラウザ (Safari/Firefox) では拡張しないので、scrollbar で
            内容を読めるようにする fallback。対応ブラウザでは content に合わせて伸びるので scrollbar も出ない。
            min-height は 60px キープ、max-height は撤去 (RC コメントの長文も全部見える)。 */}
        <textarea
          className="w-full min-h-[60px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-[7px] px-2.5 py-2 font-sans text-xs leading-[1.5] outline-none transition-colors duration-[120ms] focus:border-accent disabled:bg-surface-2 disabled:text-text-dim disabled:cursor-not-allowed"
          placeholder={
            noPanels
              ? 'No panels in this group'
              : decision === 'request-changes'
                ? '修正してほしい点を書いてください...'
                : thread && thread.messages.length > 0
                  ? 'スレッドに返信 (Comment で追加)'
                  : 'この group へのコメント (Comment でスレッドに追加)'
          }
          value={comment}
          disabled={!decisionInteractive}
          onChange={(e) => onCommentChange(groupId, e.target.value)}
        />
        {/* SubmitBar と同順 (Comment → Request Changes → Approve)・同系の配色。
            nav 幅が狭くテキスト 3 つは収まらないため lucide アイコンのみ (title + aria-label で補完)。
            btn-decision + btn-approve/btn-rc BEM 維持: .is-selected で approved=緑、rc=赤の
            選択時 tint が globals.css にあるため。未選択時のベースは SubmitBar と同じ ghost 配色。 */}
        <div className="flex gap-1.5" role="group" aria-label="Group review actions">
          {/* Comment (neutral ghost): 常時表示し、空のときは disabled (入力時だけ出すと
              「送る手段がある」こと自体に気付けない)。押すと pending としてスレッドに積むだけで
              レビューは継続する。decision も確定しない。 */}
          <button
            type="button"
            className="btn-decision flex-1 px-2.5 py-1.5 border border-border bg-transparent text-text rounded-[7px] cursor-pointer transition-colors duration-[120ms] enabled:hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!decisionInteractive || comment.trim() === ''}
            onClick={() => onSubmitComment(groupId)}
            aria-label="Comment"
            title="コメントをこの group のスレッドに追加 (Claude への送信は右下の Comment / Submit でまとめて)"
          >
            <MessageSquare className="w-4 h-4 mx-auto" strokeWidth={2} aria-hidden />
          </button>
          {/* Request Changes (ghost 赤) */}
          <button
            type="button"
            className={`btn-decision btn-rc flex-1 px-2.5 py-1.5 border bg-transparent text-del-fg border-[rgba(248,113,113,0.5)] rounded-[7px] cursor-pointer transition-colors duration-[120ms] enabled:hover:bg-[rgba(248,113,113,0.12)] disabled:opacity-50 disabled:cursor-not-allowed${decision === 'request-changes' ? ' is-selected' : ''}`}
            disabled={!decisionInteractive}
            aria-pressed={decision === 'request-changes'}
            aria-label="Request changes"
            title="Request changes"
            onClick={() => onDecisionChange(groupId, decision === 'request-changes' ? null : 'request-changes')}
          >
            <X className="w-4 h-4 mx-auto" strokeWidth={2} aria-hidden />
          </button>
          {/* Approve (ghost 緑) */}
          <button
            type="button"
            className={`btn-decision btn-approve flex-1 px-2.5 py-1.5 border bg-transparent text-add-fg border-[rgba(74,222,128,0.5)] rounded-[7px] cursor-pointer transition-colors duration-[120ms] enabled:hover:bg-[rgba(74,222,128,0.12)] disabled:opacity-50 disabled:cursor-not-allowed${decision === 'approved' ? ' is-selected' : ''}`}
            disabled={!decisionInteractive}
            aria-pressed={decision === 'approved'}
            aria-label="Approve"
            title="Approve"
            onClick={() => onDecisionChange(groupId, decision === 'approved' ? null : 'approved')}
          >
            <Check className="w-4 h-4 mx-auto" strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  )
}

function PanelItem({
  panel, active, onJump,
}: {
  panel: RenderedPanel
  active: boolean
  onJump: (panelId: string) => void
}) {
  const asIs = panel.asIs?.file
  const toBe = panel.toBe?.file
  const className = [
    'group-panel-item',
    active ? 'is-active' : '',
  ].filter(Boolean).join(' ')
  // group-panel-item BEM 維持: ::before の accent rail + .is-active で rail visible 化 +
  // focus-visible で内側 box-shadow 表示 が globals.css にある。
  // base 見た目 (flex 配置 / radius / font-size) は utility で表現、上記 state は className に残置。
  return (
    <div
      className={`${className} relative flex items-stretch gap-0 bg-transparent text-text rounded-[5px] text-xs transition-colors duration-[120ms] hover:bg-surface-2`}
      aria-current={active ? 'true' : undefined}
    >
      <button
        type="button"
        className="bg-transparent border-0 py-2 pl-2.5 pr-2.5 text-left cursor-pointer text-text text-xs flex-1 min-w-0 hover:bg-surface-2 hover:rounded-[5px]"
        onClick={() => onJump(panel.panelId)}
        title={panel.intent}
      >
        <span className="flex flex-col gap-[3px] min-w-0">
          {/* panel-intent-line BEM 維持: `.group-panel-item.is-active .panel-intent-line` で text color
              を accent ON 時に上書きする rule が globals.css にあるため。 */}
          <span className="panel-intent-line text-sm font-medium text-text whitespace-normal break-words leading-[1.4] tracking-[-0.005em] transition-colors duration-[120ms]">
            {panel.intent}
          </span>
          <span className="text-2xs text-text-dim font-mono flex gap-1 items-center flex-wrap break-all">
            {asIs && toBe && asIs !== toBe ? (
              <>
                <span className="min-w-0 break-all">{basename(asIs)}</span>
                <span className="text-text-dim opacity-70" aria-hidden>→</span>
                <span className="min-w-0 break-all">{basename(toBe)}</span>
              </>
            ) : (
              <span className="min-w-0 break-all">{basename(toBe ?? asIs ?? '(no file)')}</span>
            )}
          </span>
        </span>
      </button>
    </div>
  )
}

// ---------- scroll spy hook ----------
function useScrollSpy(panels: RenderedPanel[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    if (panels.length === 0) return
    const visibility = new Map<string, boolean>()
    const ids = panels.map((p) => p.panelId)
    const recompute = () => {
      const first = ids.find((id) => visibility.get(id))
      setActiveId(first ?? null)
    }
    // 単一 IO + 複数 observe: panel ごとに IO を作ると observer インスタンスが panel 数ぶん増える
    // だけで、閾値設定は全 panel 共通なので 1 つで足りる。
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.panelId
          if (id) visibility.set(id, entry.isIntersecting)
        }
        recompute()
      },
      { rootMargin: '-30% 0px -50% 0px', threshold: 0 },
    )
    for (const id of ids) {
      // .guide-tab スコープ必須: Diff タブにも同一 panelId の .panel-block が存在するため
      // (App の jumpToRawPanel が .raw-diff-tab でスコープしているのと対称)。
      const el = document.querySelector(`.guide-tab .panel-block[data-panel-id="${cssEscape(id)}"]`)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [panels])
  return activeId
}


// ---------- icon wrappers ----------
// lucide-react で統一。各 wrapper は size / strokeWidth / 色 (currentColor 経由) のデフォルトを固定。
// SpinnerIcon は旧 .spin BEM class を捨てて utility `animate-spin` (Tailwind 標準) に切替。

function PlusIcon() {
  return <Plus size={12} strokeWidth={1.5} aria-hidden />
}

function SpinnerIcon() {
  return <LoaderCircle size={12} strokeWidth={1.5} className="animate-spin" aria-hidden />
}

function ChevronUpIcon() {
  return <ChevronUp size={12} strokeWidth={1.6} aria-hidden />
}

function ChevronDownIcon() {
  return <ChevronDown size={12} strokeWidth={1.6} aria-hidden />
}
