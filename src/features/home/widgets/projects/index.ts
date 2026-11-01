import type { WidgetDef } from '../../types'
import { ProjectsWidget } from './Widget'
import { ProjectsDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'projects',
  title: 'Projects',
  blurb: 'Every project by health and recency; switch to 14-day activity.',
  sizes: ['M', 'L', 'XL'],
  modes: ['Map', 'Activity'],
  Widget: ProjectsWidget,
  Detail: ProjectsDetail,
}
