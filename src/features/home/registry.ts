import type { WidgetDef, WidgetId } from './types'
import { widget as needs } from './widgets/needs'
import { widget as live } from './widgets/live'
import { widget as projects } from './widgets/projects'
import { widget as automation } from './widgets/automation'
import { widget as inbox } from './widgets/inbox'
import { widget as capture } from './widgets/capture'
import { widget as recall } from './widgets/recall'
import { widget as pace } from './widgets/pace'
import { widget as launch } from './widgets/launch'

// Library order — also the order of the Customize drawer.
export const WIDGETS: Record<WidgetId, WidgetDef> = { needs, live, projects, automation, inbox, capture, recall, pace, launch }
export const WIDGET_IDS: ReadonlySet<string> = new Set(Object.keys(WIDGETS))
