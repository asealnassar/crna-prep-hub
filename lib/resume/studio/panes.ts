/**
 * Which pane the Studio is showing.
 *
 * Desktop is editor left, preview right — both at once. A phone cannot show
 * both usefully, so it shows one and toggles, and EVERY section stays editable
 * there: the toggle is a layout answer, not a reduced feature set.
 *
 * Pure, so the toggle's behaviour is tested rather than clicked: the rules that
 * matter are that the chosen pane survives a rotation into desktop and back,
 * and that the preview is never the only thing a phone can reach.
 */

export type Pane = 'edit' | 'preview'
export type Viewport = 'mobile' | 'desktop'

export interface PaneState {
  readonly viewport: Viewport
  /** Which pane a mobile viewport is showing. Remembered across viewports. */
  readonly active: Pane
}

/**
 * Below this width the panes stack. Chosen to match Tailwind's `lg`, which is
 * the breakpoint the rest of this app already uses for its sidebar.
 */
export const DESKTOP_MIN_WIDTH = 1024

export function viewportFor(width: number): Viewport {
  return width >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile'
}

/** A new Studio opens on the editor: an applicant came here to write. */
export function initialPaneState(width: number): PaneState {
  return { viewport: viewportFor(width), active: 'edit' }
}

export interface PaneVisibility {
  readonly edit: boolean
  readonly preview: boolean
  /** True when the toggle should be offered at all. */
  readonly toggleable: boolean
}

export function visiblePanes(state: PaneState): PaneVisibility {
  if (state.viewport === 'desktop') {
    return { edit: true, preview: true, toggleable: false }
  }
  return {
    edit: state.active === 'edit',
    preview: state.active === 'preview',
    toggleable: true,
  }
}

export function togglePane(state: PaneState): PaneState {
  return { ...state, active: state.active === 'edit' ? 'preview' : 'edit' }
}

/** Selecting the pane already showing is a no-op, as setting the current
 *  viewport is: an identical state means React has nothing to re-render. */
export function showPane(state: PaneState, pane: Pane): PaneState {
  return state.active === pane ? state : { ...state, active: pane }
}

/**
 * Resizing changes the layout, never the choice. A phone rotated to a tablet
 * width and back shows the pane it was showing before — losing the applicant's
 * place because a soft keyboard changed the viewport height would be its own
 * small betrayal.
 */
export function setViewport(state: PaneState, viewport: Viewport): PaneState {
  return state.viewport === viewport ? state : { ...state, viewport }
}

/** The label on the button, which names where it goes rather than where it is. */
export function toggleLabel(state: PaneState): string {
  return state.active === 'edit' ? 'Preview' : 'Edit'
}
