import type { WidgetDef } from '../../types'
import { RecallWidget } from './Widget'
import { RecallDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'recall',
  title: 'Vault recall',
  blurb: 'Whether the recall hook’s offers get read, and which notes never do.',
  sizes: ['S', 'M', 'L'],
  Widget: RecallWidget,
  Detail: RecallDetail,
}
