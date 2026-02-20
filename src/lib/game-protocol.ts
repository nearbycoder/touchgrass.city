export const MAP_WIDTH = 10000
export const MAP_HEIGHT = 10000

export const PLAYER_RADIUS = 16
export const GRASS_RADIUS = 14
export const PLAYER_SPEED = 10

export type PowerupType = 'speed' | 'magnet' | 'double'

export interface PlayerSnapshot {
  connectionId: string
  userId: string
  name: string
  color: string
  x: number
  y: number
  score: number
  activePowerups: PowerupType[]
}

export interface PowerupSnapshot {
  id: string
  type: PowerupType
  x: number
  y: number
}

export interface EnemySnapshot {
  id: string
  x: number
  y: number
}

export interface RectSnapshot {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface WorldState {
  map: {
    width: number
    height: number
  }
  streets: RectSnapshot[]
  buildings: RectSnapshot[]
  grasses: Array<{
    x: number
    y: number
  }>
  powerups: PowerupSnapshot[]
  enemies: EnemySnapshot[]
  players: PlayerSnapshot[]
}

export type ClientToServerMessage =
  | {
      type: 'move'
      dx: number
      dy: number
    }
  | {
      type: 'set-color'
      color: string
    }

export type ServerToClientMessage =
  | {
      type: 'connected'
      connectionId: string
    }
  | {
      type: 'world-state'
      world: WorldState
    }
  | {
      type: 'error'
      message: string
    }
