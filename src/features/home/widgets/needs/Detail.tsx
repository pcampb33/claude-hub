import { PeekContent } from '../../peek'
import { usePeek } from '../../peek-context'
import { Actions, Btn, Empty, Loading, Row, RowList, Sec, Unreachable } from '../../parts'
import { KEYS, useExtensionsRead } from '../../reads'
import { invalidateHubRead } from '../../useHubRead'
import type { DetailProps } from '../../types'
import { runAction, useGo } from '../../actions'
import { SOURCE_LABEL } from './needs-core'
import { useNeeds } from './useNeeds'
import type { ExtensionItem } from '../../../../../shared/ipc-types'
import { healthIsCurrent, isBroken, neverUsed as itemNeverUsed } from '../../../extensions/model'
import './needs.css'

export function NeedsDetail({ ctx }: DetailProps) {
  if (ctx?.item === 'extensions') return <BrokenExtensions />
  return <AllNeeds />
}

// Every item with its reason and two ways forward: the scoped peek, and the
// view where it actually gets fixed.
function AllNeeds() {
  const { items, pending, unchecked, retry } = useNeeds()
  const { open } = usePeek()
  const go = useGo()
  const title =
    items.length > 0 ? `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you` : 'Needs you'

  return (
    <PeekContent crumb="Needs you" title={title}>
      <div className="peek-needs">
        <Sec bare>
          <p className="sub">
            Gathered from the vault inbox, automations, verify floors, CLAUDE.md health, extensions and the recall
            experiment, most urgent first.
          </p>
        </Sec>
        {items.length === 0 && unchecked.length === 0 && pending.length === 0 && (
          <Sec>
            <Empty title="Nothing needs you">Every source answered and none has anything waiting.</Empty>
          </Sec>
        )}
        {items.map((it) => (
          <Sec key={it.key}>
            <div className="need-item">
              <span className={`need-badge tone-${it.tone}`}>{it.badge}</span>
              <div>
                <b>{it.title}</b>
                <p>{it.why}</p>
                {it.sub && <div className="sub">{it.sub}</div>}
                <Actions>
                  <Btn kind="primary" onClick={() => open(it.peek.widget, it.peek.ctx)}>
                    {it.cta}
                  </Btn>
                  <Btn onClick={() => go(it.nav.view, it.nav.param)}>{it.nav.label}</Btn>
                </Actions>
              </div>
            </div>
          </Sec>
        ))}
        {unchecked.map((u) => (
          <Unreachable key={u.source} what={SOURCE_LABEL[u.source]} error={u.error} onRetry={() => retry(u.source)} />
        ))}
        {pending.length > 0 && (
          <Sec title={`Still checking ${pending.map((k) => SOURCE_LABEL[k]).join(', ')}`}>
            <Loading rows={2} />
          </Sec>
        )}
      </div>
    </PeekContent>
  )
}

const statusWords = (i: ExtensionItem) =>
  i.status === 'failed'
    ? 'fails to connect'
    : i.status === 'needs-auth'
      ? 'needs sign-in'
      : i.status === 'pending-approval'
        ? 'awaiting approval'
        : `unrecognised status: ${i.statusText ?? 'none given'}`

function BrokenExtensions() {
  const ext = useExtensionsRead()
  const go = useGo()
  const recheck = () =>
    runAction(async () => {
      await window.hubApi.recheckExtensions()
      invalidateHubRead(KEYS.extensions)
    }, 'recheck extensions')

  let body
  if (ext.status === 'loading') body = <Loading rows={4} />
  else if (ext.status === 'error') body = <Unreachable what="extensions" error={ext.error} onRetry={ext.refresh} />
  else if (!healthIsCurrent(ext.data.health)) {
    // No current check means every server is 'unchecked' — not "all fine".
    body =
      ext.data.health.state === 'running' ? (
        <Sec>
          <Empty title="Checking connections…">The health check takes a few seconds; this panel shows its result when it lands.</Empty>
        </Sec>
      ) : (
        <Unreachable
          what="extension health"
          error={ext.data.health.error ?? 'no health check has completed yet'}
          onRetry={recheck}
        />
      )
  } else {
    const broken = ext.data.items.filter(isBroken)
    const failed = broken.filter((i) => i.status === 'failed')
    const auth = broken.filter((i) => i.status === 'needs-auth')
    const other = broken.length - failed.length - auth.length
    const groups = new Map<string, ExtensionItem[]>()
    for (const i of broken) {
      const key = i.pluginId ?? 'Configured directly'
      groups.set(key, [...(groups.get(key) ?? []), i])
    }
    const usageKnown = broken.every((i) => i.usage !== null)
    const neverUsed = usageKnown && broken.every(itemNeverUsed)
    body =
      broken.length === 0 ? (
        <Sec>
          <Empty title="Every extension connects">The last health check found nothing failing or waiting for a sign-in.</Empty>
        </Sec>
      ) : (
        <>
          <Sec bare>
            <p>
              Every session tries these at start: {auth.length} wait for a sign-in and {failed.length} fail outright
              {other > 0 ? `; ${other} await approval or report a status this app doesn’t recognise` : ''}.{' '}
              {neverUsed ? 'None has ever been called.' : usageKnown ? '' : 'Whether they were ever used couldn’t be scanned.'}
            </p>
          </Sec>
          {[...groups].map(([plugin, list]) => (
            <Sec key={plugin} title={plugin}>
              <RowList tall>
                {list.map((i) => (
                  <Row
                    key={i.id}
                    label={
                      <>
                        <b>{i.name}</b> <span className="sub">· {statusWords(i)}</span>
                      </>
                    }
                    figure="Open ›"
                    target={{
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => go('extensions', i.id),
                      onKeyDown: (e: { key: string }) => e.key === 'Enter' && go('extensions', i.id),
                    }}
                  />
                ))}
              </RowList>
            </Sec>
          ))}
          {failed.some((i) => i.statusText) && (
            <Sec title="What the failures say">
              {failed
                .filter((i) => i.statusText)
                .map((i) => (
                  <div key={i.id} className="sub">
                    <b>{i.name}</b>: {i.statusText}
                  </div>
                ))}
            </Sec>
          )}
          {ext.data.health.checkedAtIso && (
            <div className="sub">Checked {new Date(ext.data.health.checkedAtIso).toLocaleString()}</div>
          )}
        </>
      )
  }

  return (
    <PeekContent crumb="Needs you" title="Extensions that can’t connect">
      <div className="peek-needs">
        {body}
        <Sec bare>
          <Actions>
            <Btn kind="primary" onClick={() => go('extensions')}>
              Open Extensions
            </Btn>
            <Btn onClick={recheck}>Recheck now</Btn>
          </Actions>
        </Sec>
      </div>
    </PeekContent>
  )
}
