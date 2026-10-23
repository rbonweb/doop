import { nanoid } from 'nanoid'

/* localStorage is missing in some test runtimes and throws in locked-down
   browsers; fall back to a per-session store so identity still works. */
const memory = new Map<string, string>()
const storage = {
  /* A value that only made it into memory (the write threw, e.g. quota
     exceeded, while reads still work) wins over localStorage, so one session
     keeps one identity instead of minting a new one per read. */
  get(key: string): string | null {
    const remembered = memory.get(key)
    if (remembered !== undefined) return remembered
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
      memory.delete(key)
    } catch {
      memory.set(key, value)
    }
  },
}

const ADJ = ['Amber', 'Cobalt', 'Mossy', 'Velvet', 'Copper', 'Ivory', 'Indigo', 'Scarlet', 'Dusky', 'Golden']
const ANIMAL = ['Fox', 'Heron', 'Otter', 'Lynx', 'Moth', 'Wren', 'Badger', 'Ibis', 'Newt', 'Hare']

function randomName() {
  return `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${ANIMAL[Math.floor(Math.random() * ANIMAL.length)]}`
}

export function getIdentity(): { clientId: string; name: string } {
  let clientId = storage.get('doop:clientId')
  if (!clientId) {
    clientId = nanoid(12)
    storage.set('doop:clientId', clientId)
  }
  let name = storage.get('doop:name')
  if (!name) {
    name = randomName()
    storage.set('doop:name', name)
  }
  return { clientId, name }
}

export function setName(name: string) {
  storage.set('doop:name', name)
}

/* A signed-out visitor chooses the name their comments carry once; it is also
   the name their cursor shows in the room. The server adds the "(guest)" mark. */
export function hasChosenGuestName(): boolean {
  return storage.get('doop:guestNamed') === '1'
}

export function chooseGuestName(name: string) {
  setName(name)
  storage.set('doop:guestNamed', '1')
}
