import type { WidgetDef } from '../../types'
import { LiveWidget } from './Widget'
import { LiveDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'live',
  title: 'Live sessions',
  blurb: 'What is running right now and how much room each session has left.',
  sizes: ['M', 'L', 'XL'],
  Widget: LiveWidget,
  Detail: LiveDetail,
}
