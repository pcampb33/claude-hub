import type { WidgetDef } from '../../types'
import { AutomationWidget } from './Widget'
import { AutomationDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'automation',
  title: 'Automation',
  blurb: 'Hooks, scheduled jobs and verify floors, graded on whether they did their job.',
  sizes: ['S', 'M', 'L'],
  Widget: AutomationWidget,
  Detail: AutomationDetail,
}
