import type { WidgetDef } from '../../types'
import { CaptureWidget } from './Widget'
import { CaptureDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'capture',
  title: 'Quick capture',
  blurb: 'Write a note straight into the vault.',
  sizes: ['S', 'M', 'L'],
  Widget: CaptureWidget,
  Detail: CaptureDetail,
}
