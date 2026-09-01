import type { LuminAPI } from '../shared/types'

declare global {
  interface Window {
    luminAPI: LuminAPI
  }
}
