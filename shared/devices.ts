/** Device presets for the 1–4 keys and the resize width snap. */
export interface DevicePreset {
  /** the digit key that applies it */
  key: '1' | '2' | '3' | '4'
  id: 'mobile' | 'tablet' | 'laptop' | 'desktop'
  label: string
  width: number
  height: number
}

export const DEVICES: readonly DevicePreset[] = [
  { key: '1', id: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { key: '2', id: 'tablet', label: 'Tablet', width: 834, height: 1194 },
  { key: '3', id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
  { key: '4', id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
]

export const DEVICE_WIDTHS: readonly number[] = DEVICES.map((d) => d.width)
