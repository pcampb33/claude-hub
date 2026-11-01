import type { WidgetDef } from '../../types'
import { LaunchWidget } from './Widget'
import { LaunchDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'launch',
  title: 'Launch pad',
  blurb: 'Your most-used commands and workflows, one click from a session.',
  sizes: ['S', 'M', 'L'],
  Widget: LaunchWidget,
  Detail: LaunchDetail,
}
