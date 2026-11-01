import { GLOSSARY_GROUPS } from './glossary'

// The "What do the labels mean?" panel — a glossary of every shape/badge the
// workflow cards use, including terms no current workflow happens to use, so
// the vocabulary is learnable up front.
export function WorkflowLegend({ onClose }: { onClose: () => void }) {
  return (
    <div className="wf-legend" role="region" aria-label="What the workflow labels mean">
      <div className="wf-legend-head">
        <span className="wf-legend-title">What the labels mean</span>
        <button className="wf-legend-close" onClick={onClose} aria-label="Close legend">
          ✕
        </button>
      </div>
      <div className="wf-legend-groups">
        {GLOSSARY_GROUPS.map((group) => (
          <div className="wf-legend-group" key={group.title}>
            <div className="wf-legend-group-title">{group.title}</div>
            <dl className="wf-legend-list">
              {group.terms.map((t) => (
                <div className="wf-legend-item" key={t.term}>
                  <dt className="wf-legend-term">{t.label}</dt>
                  <dd className="wf-legend-def">{t.def}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  )
}
