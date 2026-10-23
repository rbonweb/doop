import { create } from 'zustand'
import { canvasPages, framePageId, pageFrames } from '../../shared/pages'
import { shiftAttachedNotes } from '../../shared/notes'
import type {
  ActivityItem,
  AgentTask,
  Canvas,
  CanvasNote,
  CanvasRole,
  ChatMessage,
  DesignDecision,
  ElementComment,
  Frame,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  PeerViewport,
  Presence,
  TaskFeedback,
} from '../../shared/types'
import type { SnapGuide } from './snap'
import { fitViewport, zoomAroundCenter } from './fit'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export type PanelTab = 'tasks' | 'chat' | 'activity' | 'memory'

const chatSeenKey = (canvasId: string) => `doop:chatSeen:${canvasId}`

function loadChatSeen(canvasId: string): number {
  try {
    return Number(localStorage.getItem(chatSeenKey(canvasId)) ?? 0) || 0
  } catch {
    return 0
  }
}

interface State {
  canvas: Canvas | null
  presences: Record<string, Presence>
  cursors: Record<string, { x: number; y: number }>
  activity: ActivityItem[]
  /** agent task history (newest first) — every set_status becomes a task */
  tasks: AgentTask[]
  /** human feedback on tasks (newest first) */
  feedback: TaskFeedback[]
  /** element-anchored comments (newest first) */
  comments: ElementComment[]
  /** the canvas chat (newest first) */
  chat: ChatMessage[]
  /** when this browser last had the chat open on this canvas — everything
   *  newer from someone else counts as unread on the rail */
  chatSeenAt: number
  /** design decisions captured into Memory (newest first) */
  decisions: DesignDecision[]
  /** distiller rule proposals (newest first) */
  proposals: MemoryProposal[]
  /** which tab the side panel shows — in the store so a Memory-suggestion
   *  toast anywhere in the app can jump straight to the Memory tab */
  panelTab: PanelTab
  /** every selected frame, in selection order — marquee and ⇧-click build
   *  this up; a plain click collapses it to one */
  selectedIds: string[]
  /** the primary selection (the last frame added) — what the Inspector,
   *  presence, and the flow overlay follow */
  selectedId: string | null
  /** space bar held: the stage pans on drag instead of drawing a marquee */
  panMode: boolean
  /** the Inspector panel is showing — opened by clicking a frame's name, not
   *  by mere selection, so clicking around a frame doesn't slide the panel in */
  inspectorOpen: boolean
  /** open frame context menu; deferPanel hides the Inspector until it closes
   *  (right-click selecting a frame must not slide a panel in under the menu) */
  ctxMenu: { frameId: string; deferPanel: boolean } | null
  /** frames the export dialog is open for (null: closed) — set by the frame's Export button, the top bar, and ⌘⇧E */
  exportIds: string[] | null
  /** the element outlined inside the selected frame — a click on the frame
   *  surface and a click on a Layers row both land here, so the outline in
   *  the frame and the highlighted row stay in step */
  selectedElement: { frameId: string; selector: string } | null
  /** the element properties panel is showing — opened by a pick (a click on
   *  the frame surface or a Layers row), it then follows whatever element is
   *  selected until it is closed */
  elementPanelOpen: boolean
  /** the Layers rail is showing (desktop); the choice sticks across visits */
  layersOpen: boolean
  /** the frame whose version history panel is open, if any — it takes the
   *  Inspector's spot until closed */
  historyFrameId: string | null
  viewport: Viewport
  /** the stage's size in screen px, kept current by the Stage — what fit and zoom shortcuts measure against */
  stageSize: { width: number; height: number } | null
  /** laser mode: every frame outlines its element tree and the next click copies an element's path */
  laser: boolean
  /** comment mode: the next element click in any frame opens the comment composer on it */
  commentMode: boolean
  /** the Keyboard shortcuts dialog is showing */
  shortcutsOpen: boolean
  /** live alignment guide lines while a frame drag is snapped to a neighbour */
  snapGuides: SnapGuide[]
  connected: boolean
  /** the join for the current canvasId was refused: no such canvas (deleted,
   *  or the id in the URL was never one) — CanvasPage shows a not-found
   *  screen instead of an unusable, unresponsive canvas UI */
  canvasNotFound: boolean
  /** a reconnect revealed a newer client bundle on the server — offer a reload */
  updateReady: boolean
  /** what this connection may do on the open canvas; null until the join is answered */
  role: CanvasRole | null
  /** a signed-out visitor on an anyone-with-the-link canvas */
  guest: boolean
  /** the server refused the join (no access, or it was taken away) — CanvasPage
   *  shows the no-access screen with the request form */
  noAccess: boolean
  /** commentId -> when someone @mentioned you in it: the pin pulses for a while */
  pulses: Record<string, number>
  /** bumped when someone asks for access, so an open Share dialog re-reads its list */
  accessRequestTick: number
  /** a guest is about to comment and has not given a name yet: the prompt that
   *  asks settles this request */
  guestNameRequest: { resolve: (name: string) => void; reject: () => void } | null
  /** frameId -> color, set briefly when a remote actor updates a frame */
  flashes: Record<string, { color: string; at: number }>
  /** frameId -> actor currently streaming a design into it */
  streams: Record<string, { name: string; color: string }>
  /** a transient toast — in the store so long actions fired from surfaces
   *  that close at once (a context menu) can still report back. A `busy`
   *  notice (an export in flight) stays up until the next notice replaces it. */
  notice: { text: string; at: number; busy?: boolean } | null
  /** the free-tier wall is showing — in the store so any surface that hits
   *  the resident-task limit (board, prompt bar, element comment) can raise it */
  limitWall: boolean
  /** bumped whenever the allowance could have changed (a model account was
   *  connected or dropped) so every meter on screen re-reads it */
  allowanceVersion: number
  /** a request for the Stage to glide the camera to a frame — the prompt bar
   *  raises it so a first deliverable streams in on-screen, never off-canvas */
  flyTo: { frameId: string; at: number } | { point: { x: number; y: number }; at: number } | null
  /** sticky notes are showing on the stage — per viewer, `n` toggles it */
  notesVisible: boolean
  /** notes this viewer has folded down to a corner chip */
  foldedNotes: Record<string, true>
  /** the note whose text is open for editing on this client */
  editingNoteId: string | null
  /** clientId of the peer whose camera this one is tracking (Figma-style
   *  follow); any camera move of our own lets go */
  following: string | null
  /** the full-screen present mode is open (frames behind it never sleep, see lib/frameSleep.ts) */
  presenting: boolean
  setPresenting(v: boolean): void

  activePageId: string | null
  setActivePage(id: string): void
  setPages(pages: import('../../shared/types').CanvasPageInfo[], canvasId?: string): void
  setCanvas(c: Canvas | null): void
  setConnected(v: boolean): void
  setCanvasNotFound(v: boolean): void
  setUpdateReady(v: boolean): void
  setRole(role: CanvasRole | null): void
  setGuest(guest: boolean): void
  setNoAccess(v: boolean): void
  /** you were @mentioned in this thread: pulse its pin */
  pulseComment(rootId: string): void
  bumpAccessRequests(): void
  clearPulse(rootId: string): void
  setGuestNameRequest(request: State['guestNameRequest']): void
  setPresences(list: Presence[]): void
  upsertPresence(p: Presence): void
  removePresence(clientId: string): void
  setCursor(clientId: string, x: number, y: number): void
  setEditing(clientId: string, frameId: string | null): void
  setPeerViewport(clientId: string, viewport: PeerViewport): void
  /** start (clientId) or stop (null) following a peer's camera */
  setFollowing(clientId: string | null): void
  /** camera write that keeps the follow alive — only the follow loop uses it */
  setViewportFollowing(v: Viewport): void
  setStatus(clientId: string, status: string | null): void
  setActivity(items: ActivityItem[]): void
  pushActivity(item: ActivityItem): void
  setTasks(tasks: AgentTask[]): void
  upsertTask(task: AgentTask): void
  setFeedback(feedback: TaskFeedback[]): void
  upsertFeedback(fb: TaskFeedback): void
  setComments(comments: ElementComment[]): void
  upsertComment(c: ElementComment): void
  setChat(messages: ChatMessage[]): void
  pushChat(message: ChatMessage): void
  /** the chat is on screen: nothing is unread any more */
  markChatSeen(): void
  upsertFrame(f: Frame): void
  patchFrameLocal(frameId: string, patch: Partial<Frame>): void
  removeFrame(frameId: string): void
  renameCanvasLocal(name: string): void
  /** insert or replace a sticky note on the open canvas */
  upsertNote(note: CanvasNote): void
  removeNote(id: string): void
  /** move/resize/recolour a note in this client only (a drag in flight, an optimistic save) */
  patchNoteLocal(id: string, patch: Partial<CanvasNote>): void
  setNotesVisible(v: boolean): void
  toggleNoteFolded(id: string): void
  setEditingNote(id: string | null): void
  /** upsert (doc set) or remove (doc null) a style guide on the open canvas */
  setGuidelineLocal(name: string, doc: GuidelineDoc | null): void
  /** pin (reference set) or unpin (null) a Memory reference on the open canvas */
  setReferenceLocal(id: string, reference: MemoryReference | null): void
  setDecisions(decisions: DesignDecision[]): void
  pushDecision(decision: DesignDecision): void
  setProposals(proposals: MemoryProposal[]): void
  upsertProposal(proposal: MemoryProposal): void
  setPanelTab(tab: PanelTab): void
  /** show `text` as a toast for a few seconds — or, with `busy`, with a
   *  spinner until the next notice replaces it */
  pushNotice(text: string, options?: { busy?: boolean }): void
  setLimitWall(v: boolean): void
  allowanceChanged(): void
  requestFlyTo(frameId: string): void
  /** glide the camera to a world point at the current zoom (a peer's cursor) */
  requestFlyToPoint(x: number, y: number): void
  select(id: string | null): void
  /** ⇧-click: add the frame to the selection, or drop it if already in */
  toggleSelect(id: string): void
  /** marquee: replace the selection with these frames */
  selectMany(ids: string[]): void
  setPanMode(v: boolean): void
  setInspectorOpen(v: boolean): void
  openExport(frameIds: string[]): void
  closeExport(): void
  openCtxMenu(menu: { frameId: string; deferPanel: boolean }): void
  closeCtxMenu(): void
  setSelectedElement(el: { frameId: string; selector: string } | null): void
  /** an element picked by the user — on the frame surface or in the Layers
   *  rail: selects it and opens its properties panel; picking nothing clears
   *  the selection and closes the panel */
  pickElement(el: { frameId: string; selector: string } | null): void
  setElementPanelOpen(v: boolean): void
  setLayersOpen(v: boolean): void
  openFrameHistory(frameId: string | null): void
  setViewport(v: Viewport): void
  setStageSize(size: { width: number; height: number } | null): void
  /** frame every frame on the current page */
  fitAll(): void
  /** frame the selected frames; with nothing selected, the whole page */
  fitSelection(): void
  /** zoom to a level around the stage center */
  zoomTo(zoom: number): void
  /** laser and comment mode are exclusive: turning one on turns the other off */
  setLaser(on: boolean): void
  setCommentMode(on: boolean): void
  setShortcutsOpen(open: boolean): void
  setSnapGuides(guides: SnapGuide[]): void
  flash(frameId: string, color: string): void
  setStream(frameId: string, actor: { name: string; color: string } | null): void
}

const LAYERS_OPEN_KEY = 'doop:layers-open'
const NOTES_VISIBLE_KEY = 'doop:notes-visible'
const NOTES_FOLDED_KEY = 'doop:notes-folded'
/* longer than the slowest real export (Canva: render + verify, ~3 min) */
const BUSY_NOTICE_MAX_MS = 5 * 60_000

function readLayersOpen(): boolean {
  try {
    return localStorage.getItem(LAYERS_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function readNotesVisible(): boolean {
  try {
    return localStorage.getItem(NOTES_VISIBLE_KEY) !== '0'
  } catch {
    return true
  }
}

function readFoldedNotes(): Record<string, true> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(NOTES_FOLDED_KEY) ?? '[]')
    return Array.isArray(ids)
      ? Object.fromEntries(ids.filter((id) => typeof id === 'string').map((id) => [id, true]))
      : {}
  } catch {
    return {}
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode: the choice just doesn't stick */
  }
}

export const useStore = create<State>((set, get) => ({
  canvas: null,
  activePageId: null,
  presences: {},
  cursors: {},
  activity: [],
  tasks: [],
  feedback: [],
  comments: [],
  chat: [],
  chatSeenAt: 0,
  decisions: [],
  proposals: [],
  panelTab: 'tasks',
  limitWall: false,
  allowanceVersion: 0,
  flyTo: null,
  following: null,
  presenting: false,
  selectedIds: [],
  selectedId: null,
  panMode: false,
  inspectorOpen: false,
  ctxMenu: null,
  exportIds: null,
  selectedElement: null,
  elementPanelOpen: false,
  layersOpen: readLayersOpen(),
  historyFrameId: null,
  notesVisible: readNotesVisible(),
  foldedNotes: readFoldedNotes(),
  editingNoteId: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  stageSize: null,
  laser: false,
  commentMode: false,
  shortcutsOpen: false,
  snapGuides: [],
  connected: false,
  canvasNotFound: false,
  updateReady: false,
  role: null,
  guest: false,
  noAccess: false,
  pulses: {},
  accessRequestTick: 0,
  guestNameRequest: null,
  notice: null,
  flashes: {},
  streams: {},

  setCanvas: (canvas) =>
    set((s) => ({
      canvas,
      activePageId: canvas
        ? canvas.id === s.canvas?.id && canvasPages(canvas).some((p) => p.id === s.activePageId)
          ? s.activePageId
          : canvasPages(canvas)[0]!.id
        : null,
    })),
  setActivePage: (id) =>
    set((s) => {
      if (!s.canvas || !canvasPages(s.canvas).some((p) => p.id === id) || s.activePageId === id) return {}
      return {
        activePageId: id,
        selectedId: null,
        selectedIds: [],
        selectedElement: null,
        elementPanelOpen: false,
        inspectorOpen: false,
        ctxMenu: null,
        following: null,
        snapGuides: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }
    }),
  setPages: (pages, canvasId) =>
    set((s) => {
      if (!s.canvas || (canvasId !== undefined && s.canvas.id !== canvasId)) return {}
      const firstId = canvasPages(s.canvas)[0]!.id
      const canvas = { ...s.canvas, pages, frames: s.canvas.frames.map((f) => ({ ...f, pageId: f.pageId ?? firstId })) }
      const activePageId = pages.some((p) => p.id === s.activePageId) ? s.activePageId : pages[0]!.id
      return {
        canvas,
        activePageId,
        ...(activePageId !== s.activePageId
          ? {
              selectedId: null,
              selectedIds: [],
              selectedElement: null,
              inspectorOpen: false,
              elementPanelOpen: false,
              ctxMenu: null,
              following: null,
            }
          : {}),
      }
    }),
  setConnected: (connected) => set({ connected }),
  setCanvasNotFound: (canvasNotFound) => set({ canvasNotFound }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setRole: (role) => set({ role }),
  setGuest: (guest) => set({ guest }),
  setNoAccess: (noAccess) => set({ noAccess }),
  pulseComment: (rootId) => {
    const at = Date.now()
    set((s) => ({ pulses: { ...s.pulses, [rootId]: at } }))
    setTimeout(() => {
      if (get().pulses[rootId] !== at) return
      set((s) => {
        const pulses = { ...s.pulses }
        delete pulses[rootId]
        return { pulses }
      })
    }, 30_000)
  },
  bumpAccessRequests: () => set((s) => ({ accessRequestTick: s.accessRequestTick + 1 })),
  clearPulse: (rootId) =>
    set((s) => {
      if (!(rootId in s.pulses)) return {}
      const pulses = { ...s.pulses }
      delete pulses[rootId]
      return { pulses }
    }),
  setGuestNameRequest: (guestNameRequest) => set({ guestNameRequest }),
  setPresences: (list) =>
    set((s) => ({
      presences: Object.fromEntries(list.map((p) => [p.clientId, p])),
      /* a fresh roster (new canvas, reconnect) without our leader ends the follow */
      ...(s.following && !list.some((p) => p.clientId === s.following) ? { following: null } : {}),
    })),
  upsertPresence: (p) => set((s) => ({ presences: { ...s.presences, [p.clientId]: p } })),
  removePresence: (clientId) =>
    set((s) => {
      const presences = { ...s.presences }
      const cursors = { ...s.cursors }
      delete presences[clientId]
      delete cursors[clientId]
      /* the one we were following left: nothing to track any more */
      return { presences, cursors, ...(s.following === clientId ? { following: null } : {}) }
    }),
  setPeerViewport: (clientId, viewport) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, viewport } } }
    }),
  setFollowing: (following) => {
    const pageId = following ? get().presences[following]?.viewport?.pageId : undefined
    if (pageId) get().setActivePage(pageId)
    set({ following })
  },
  setViewportFollowing: (viewport) => set({ viewport }),
  setCursor: (clientId, x, y) => set((s) => ({ cursors: { ...s.cursors, [clientId]: { x, y } } })),
  setEditing: (clientId, frameId) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, activeFrameId: frameId } } }
    }),
  setStatus: (clientId, status) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, status: status ?? undefined } } }
    }),
  setActivity: (activity) => set({ activity }),
  pushActivity: (item) =>
    set((s) => (s.activity.some((a) => a.id === item.id) ? {} : { activity: [item, ...s.activity].slice(0, 100) })),
  setTasks: (tasks) => set({ tasks }),
  upsertTask: (task) =>
    set((s) => {
      const tasks = s.tasks.some((t) => t.id === task.id)
        ? s.tasks.map((t) => (t.id === task.id ? task : t))
        : [task, ...s.tasks].slice(0, 100)
      return { tasks }
    }),
  setFeedback: (feedback) => set({ feedback }),
  setComments: (comments) => set({ comments }),
  setChat: (chat) => set((s) => ({ chat, chatSeenAt: s.canvas ? loadChatSeen(s.canvas.id) : 0 })),
  pushChat: (message) =>
    set((s) => (s.chat.some((m) => m.id === message.id) ? {} : { chat: [message, ...s.chat].slice(0, 300) })),
  markChatSeen: () =>
    set((s) => {
      const latest = s.chat[0]?.at ?? 0
      if (latest <= s.chatSeenAt) return {}
      if (s.canvas) {
        try {
          localStorage.setItem(chatSeenKey(s.canvas.id), String(latest))
        } catch {
          /* private mode: the badge just comes back next visit */
        }
      }
      return { chatSeenAt: latest }
    }),
  upsertComment: (c) =>
    set((s) => {
      const comments = s.comments.some((x) => x.id === c.id)
        ? s.comments.map((x) => (x.id === c.id ? c : x))
        : [c, ...s.comments].slice(0, 100)
      return { comments }
    }),
  upsertFeedback: (fb) =>
    set((s) => {
      const feedback = s.feedback.some((f) => f.id === fb.id)
        ? s.feedback.map((f) => (f.id === fb.id ? fb : f))
        : [fb, ...s.feedback].slice(0, 100)
      return { feedback }
    }),
  upsertFrame: (f) =>
    set((s) => {
      if (!s.canvas || f.canvasId !== s.canvas.id) return {}
      const frames = s.canvas.frames.some((x) => x.id === f.id)
        ? s.canvas.frames.map((x) => (x.id === f.id ? f : x))
        : [...s.canvas.frames, f]
      const hidden = s.selectedIds.includes(f.id) && framePageId(s.canvas, f) !== s.activePageId
      return {
        canvas: { ...s.canvas, frames },
        ...(hidden
          ? {
              selectedIds: s.selectedIds.filter((id) => id !== f.id),
              selectedId: null,
              selectedElement: null,
              inspectorOpen: false,
              elementPanelOpen: false,
            }
          : {}),
      }
    }),
  /* A frame that moves takes its attached notes along by the same delta. This
     is the one local path every move goes through (a drag, a peer's drag, an
     undo), so notes never lag behind; the server shifts them by the same
     arithmetic when the move is saved. */
  patchFrameLocal: (frameId, patch) =>
    set((s) => {
      if (!s.canvas) return {}
      const before = s.canvas.frames.find((f) => f.id === frameId)
      const moves = before
        ? shiftAttachedNotes(
            s.canvas.notes ?? [],
            frameId,
            (patch.x ?? before.x) - before.x,
            (patch.y ?? before.y) - before.y,
          )
        : []
      const byId = new Map(moves.map((m) => [m.id, m]))
      return {
        canvas: {
          ...s.canvas,
          frames: s.canvas.frames.map((f) => (f.id === frameId ? { ...f, ...patch } : f)),
          ...(moves.length ? { notes: s.canvas.notes?.map((n) => ({ ...n, ...byId.get(n.id) })) } : {}),
        },
      }
    }),
  removeFrame: (frameId) =>
    set((s) => {
      if (!s.canvas) return {}
      const selectedIds = s.selectedIds.filter((id) => id !== frameId)
      const notes = s.canvas.notes?.filter((n) => n.frameId !== frameId)
      return {
        canvas: {
          ...s.canvas,
          frames: s.canvas.frames.filter((f) => f.id !== frameId),
          /* a note attached to the frame goes with it */
          ...(notes && notes.length !== s.canvas.notes?.length ? { notes } : {}),
        },
        selectedIds,
        /* losing the primary promotes the last surviving member, so a group
           never sits selected with nothing driving the Inspector/presence */
        selectedId: s.selectedId === frameId ? (selectedIds[selectedIds.length - 1] ?? null) : s.selectedId,
        /* an open Inspector must not silently retarget onto the promoted frame */
        inspectorOpen: s.selectedId === frameId ? false : s.inspectorOpen,
        ctxMenu: s.ctxMenu?.frameId === frameId ? null : s.ctxMenu,
      }
    }),
  upsertNote: (note) =>
    set((s) => {
      if (!s.canvas || note.canvasId !== s.canvas.id) return {}
      const notes = s.canvas.notes ?? []
      return {
        canvas: {
          ...s.canvas,
          notes: notes.some((n) => n.id === note.id)
            ? notes.map((n) => (n.id === note.id ? note : n))
            : [...notes, note],
        },
      }
    }),
  removeNote: (id) =>
    set((s) => {
      if (!s.canvas?.notes?.some((n) => n.id === id)) return {}
      const notes = s.canvas.notes.filter((n) => n.id !== id)
      const { [id]: _folded, ...foldedNotes } = s.foldedNotes
      return {
        canvas: { ...s.canvas, notes },
        foldedNotes,
        editingNoteId: s.editingNoteId === id ? null : s.editingNoteId,
      }
    }),
  patchNoteLocal: (id, patch) =>
    set((s) => {
      if (!s.canvas?.notes?.some((n) => n.id === id)) return {}
      return { canvas: { ...s.canvas, notes: s.canvas.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) } }
    }),
  setNotesVisible: (notesVisible) => {
    remember(NOTES_VISIBLE_KEY, notesVisible ? '1' : '0')
    set({ notesVisible })
  },
  toggleNoteFolded: (id) =>
    set((s) => {
      const foldedNotes = { ...s.foldedNotes }
      if (foldedNotes[id]) delete foldedNotes[id]
      else foldedNotes[id] = true
      remember(NOTES_FOLDED_KEY, JSON.stringify(Object.keys(foldedNotes)))
      return { foldedNotes }
    }),
  setEditingNote: (editingNoteId) => set({ editingNoteId }),
  renameCanvasLocal: (name) => set((s) => (s.canvas ? { canvas: { ...s.canvas, name } } : {})),
  setGuidelineLocal: (name, doc) =>
    set((s) => {
      if (!s.canvas) return {}
      const docs = (s.canvas.guidelines ?? []).filter((d) => d.name !== name)
      if (doc) {
        docs.push(doc)
        docs.sort((a, b) => a.name.localeCompare(b.name))
      }
      return { canvas: { ...s.canvas, guidelines: docs } }
    }),
  setReferenceLocal: (id, reference) =>
    set((s) => {
      if (!s.canvas) return {}
      const refs = (s.canvas.references ?? []).filter((r) => r.id !== id)
      if (reference) refs.unshift(reference)
      return { canvas: { ...s.canvas, references: refs } }
    }),
  setDecisions: (decisions) => set({ decisions }),
  pushDecision: (decision) =>
    set((s) => {
      /* upsert by id — the summarizer re-broadcasts the same decision with
         its generalized summary attached a moment after capture */
      const decisions = s.decisions.some((d) => d.id === decision.id)
        ? s.decisions.map((d) => (d.id === decision.id ? decision : d))
        : [decision, ...s.decisions].slice(0, 100)
      return { decisions }
    }),
  setProposals: (proposals) => set({ proposals }),
  upsertProposal: (proposal) =>
    set((s) => {
      const proposals = s.proposals.some((p) => p.id === proposal.id)
        ? s.proposals.map((p) => (p.id === proposal.id ? proposal : p))
        : [proposal, ...s.proposals].slice(0, 100)
      return { proposals }
    }),
  setPanelTab: (panelTab) => set({ panelTab }),
  pushNotice: (text, options) => {
    const busy = options?.busy === true
    const at = Date.now()
    set({ notice: { text, at, busy } })
    if (busy) {
      /* a backstop for a request that never settles (a stalled Canva
         export) — normally the outcome replaces a busy notice long before */
      setTimeout(() => {
        if (get().notice?.at === at) set({ notice: null })
      }, BUSY_NOTICE_MAX_MS)
      return
    }
    setTimeout(() => {
      const cur = get().notice
      /* only clear our own notice — a newer one restarts the clock */
      if (cur && !cur.busy && Date.now() - cur.at >= 4900) set({ notice: null })
    }, 5000)
  },
  setLimitWall: (limitWall) => set({ limitWall }),
  allowanceChanged: () => set((s) => ({ allowanceVersion: s.allowanceVersion + 1 })),
  requestFlyTo: (frameId) => {
    const s = get()
    const frame = s.canvas?.frames.find((f) => f.id === frameId)
    if (frame && s.canvas) s.setActivePage(framePageId(s.canvas, frame))
    set({ flyTo: { frameId, at: Date.now() } })
  },
  requestFlyToPoint: (x, y) => set({ flyTo: { point: { x, y }, at: Date.now() } }),
  /* selecting a different frame (or deselecting) closes the Inspector — the
     panel must not follow surface clicks, paste, or undo onto another frame.
     Re-selecting the same frame keeps an open panel open. */
  select: (selectedId) => {
    const state = get()
    const frame = state.canvas?.frames.find((f) => f.id === selectedId)
    if (frame && state.canvas) state.setActivePage(framePageId(state.canvas, frame))
    set((s) => {
      const selectedIds = selectedId ? [selectedId] : []
      return s.selectedId === selectedId
        ? { selectedId, selectedIds }
        : { selectedId, selectedIds, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    })
  },
  toggleSelect: (id) =>
    set((s) => {
      const selectedIds = s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
      const selectedId = selectedIds[selectedIds.length - 1] ?? null
      return selectedId === s.selectedId
        ? { selectedIds }
        : { selectedIds, selectedId, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    }),
  selectMany: (ids) => {
    const state = get()
    const frame = state.canvas?.frames.find((f) => f.id === ids[ids.length - 1])
    if (frame && state.canvas) state.setActivePage(framePageId(state.canvas, frame))
    set((s) => {
      const selectedId = ids[ids.length - 1] ?? null
      return selectedId === s.selectedId
        ? { selectedIds: ids }
        : { selectedIds: ids, selectedId, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    })
  },
  setPanMode: (panMode) => set({ panMode }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  openExport: (exportIds) => set({ exportIds }),
  closeExport: () => set({ exportIds: null }),
  openCtxMenu: (ctxMenu) => set({ ctxMenu }),
  closeCtxMenu: () => set({ ctxMenu: null }),
  setSelectedElement: (selectedElement) =>
    set((s) =>
      s.selectedElement?.frameId === selectedElement?.frameId &&
      s.selectedElement?.selector === selectedElement?.selector
        ? s
        : { selectedElement },
    ),
  pickElement: (el) =>
    set((s) => {
      if (!el) return s.selectedElement || s.elementPanelOpen ? { selectedElement: null, elementPanelOpen: false } : s
      const same = s.selectedElement?.frameId === el.frameId && s.selectedElement?.selector === el.selector
      if (same && s.elementPanelOpen) return s
      return { selectedElement: same ? s.selectedElement : el, elementPanelOpen: true }
    }),
  setElementPanelOpen: (elementPanelOpen) => set({ elementPanelOpen }),
  openFrameHistory: (historyFrameId) => set({ historyFrameId }),
  setLayersOpen: (layersOpen) => {
    try {
      localStorage.setItem(LAYERS_OPEN_KEY, layersOpen ? '1' : '0')
    } catch {
      /* private mode: the choice just doesn't stick */
    }
    set({ layersOpen })
  },
  /* every ordinary camera move (pan, zoom, fit, fly-to) is ours, so it ends a follow */
  setViewport: (viewport) => set({ viewport, following: null }),
  setStageSize: (stageSize) =>
    set((s) =>
      s.stageSize?.width === stageSize?.width && s.stageSize?.height === stageSize?.height ? s : { stageSize },
    ),
  fitAll: () => {
    const s = get()
    if (!s.stageSize || !s.canvas) return
    const frames = pageFrames(s.canvas, s.activePageId ?? canvasPages(s.canvas)[0]!.id)
    s.setViewport(fitViewport(frames, s.stageSize))
  },
  fitSelection: () => {
    const s = get()
    if (!s.stageSize || !s.canvas) return
    const frames = pageFrames(s.canvas, s.activePageId ?? canvasPages(s.canvas)[0]!.id)
    const picked = frames.filter((f) => s.selectedIds.includes(f.id))
    s.setViewport(fitViewport(picked.length ? picked : frames, s.stageSize))
  },
  zoomTo: (zoom) => {
    const s = get()
    if (s.stageSize) s.setViewport(zoomAroundCenter(s.viewport, zoom, s.stageSize))
  },
  setLaser: (laser) => set((s) => (laser ? { laser, commentMode: false } : s.laser ? { laser } : s)),
  setCommentMode: (commentMode) =>
    set((s) => (commentMode ? { commentMode, laser: false } : s.commentMode ? { commentMode } : s)),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  /* fires on every pointermove during a drag — skip the no-op transitions
     so unsnapped drags don't render the (empty) guide layer each frame */
  setPresenting: (presenting) => set({ presenting }),
  setSnapGuides: (snapGuides) =>
    set((s) => (snapGuides.length === 0 && s.snapGuides.length === 0 ? s : { snapGuides })),
  setStream: (frameId, actor) =>
    set((s) => {
      const streams = { ...s.streams }
      if (actor) streams[frameId] = actor
      else delete streams[frameId]
      return { streams }
    }),
  flash: (frameId, color) => {
    set((s) => ({ flashes: { ...s.flashes, [frameId]: { color, at: Date.now() } } }))
    setTimeout(() => {
      const cur = get().flashes[frameId]
      if (cur && Date.now() - cur.at >= 1150) {
        set((s) => {
          const flashes = { ...s.flashes }
          delete flashes[frameId]
          return { flashes }
        })
      }
    }, 1200)
  },
}))
