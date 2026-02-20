import { createFileRoute } from '@tanstack/react-router'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { authClient } from '#/lib/auth-client'
import {
  type ClientToServerMessage,
  type PowerupType,
  type RectSnapshot,
  type ServerToClientMessage,
  type WorldState,
} from '#/lib/game-protocol'

export const Route = createFileRoute('/')({ component: App })

type AuthMode = 'signin' | 'signup'
type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface SmoothedPlayer {
  x: number
  y: number
  name: string
  color: string
  score: number
  userId: string
  activePowerups: PowerupType[]
}

interface SmoothedEnemy {
  x: number
  y: number
}

const TILE_STYLE: CSSProperties = {
  backgroundColor: '#1d4d2f',
  backgroundImage:
    'linear-gradient(rgba(76, 145, 95, 0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(76, 145, 95, 0.35) 1px, transparent 1px), radial-gradient(circle at 25% 25%, rgba(12, 35, 20, 0.35), transparent 55%)',
  backgroundSize: '180px 180px, 180px 180px, 360px 360px',
}

const CAMERA_LERP = 0.18
const PLAYER_LERP = 0.32
const ENEMY_SMOOTHING_RATE = 14
const PLAYER_RADIUS = 18
const GRASS_SIZE = 36
const POWERUP_SIZE = 28
const ENEMY_SIZE = 40
const JOYSTICK_RADIUS = 56
const JOYSTICK_DEADZONE = 0.06
const GRASS_TEXTURE_URL = '/grass-tile.svg'
const CLIENT_JOIN_DELAY_MS = 5_000
const PLAYER_COLOR_STORAGE_KEY = 'touchgrass:preferred-color'
const DEFAULT_PLAYER_COLOR = '#22c55e'
const COLOR_PRESETS = [
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#0ea5e9',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#f59e0b',
]
const POWERUP_LABELS: Record<PowerupType, string> = {
  speed: 'Speed',
  magnet: 'Magnet',
  double: '2x Points',
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  const shortMatch = /^#?([0-9a-f]{3})$/i.exec(trimmed)
  if (shortMatch) {
    const [r, g, b] = shortMatch[1]
    return `#${r}${r}${g}${g}${b}${b}`
  }

  const fullMatch = /^#?([0-9a-f]{6})$/i.exec(trimmed)
  if (!fullMatch) {
    return null
  }

  return `#${fullMatch[1]}`
}

function App() {
  const { data: session, isPending: sessionPending } = authClient.useSession()

  const [authMode, setAuthMode] = useState<AuthMode>('signup')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authPending, setAuthPending] = useState(false)

  const [world, setWorld] = useState<WorldState | null>(null)
  const [selfConnectionId, setSelfConnectionId] = useState<string | null>(null)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('disconnected')
  const [socketError, setSocketError] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [fps, setFps] = useState(0)
  const [touchStick, setTouchStick] = useState({ active: false, x: 0, y: 0 })
  const [selectedColor, setSelectedColor] = useState(DEFAULT_PLAYER_COLOR)
  const [settingsColor, setSettingsColor] = useState(DEFAULT_PLAYER_COLOR)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [joinCountdownMs, setJoinCountdownMs] = useState(0)

  const socketRef = useRef<WebSocket | null>(null)
  const pressedKeysRef = useRef<Set<string>>(new Set())
  const touchVectorRef = useRef({ dx: 0, dy: 0 })
  const touchPointerIdRef = useRef<number | null>(null)
  const touchOriginRef = useRef({ x: 0, y: 0 })
  const preferredColorRef = useRef(DEFAULT_PLAYER_COLOR)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const worldRef = useRef<WorldState | null>(null)
  const selfConnectionIdRef = useRef<string | null>(null)
  const sessionUserIdRef = useRef<string | null>(null)
  const viewportRef = useRef({ width: 0, height: 0 })
  const smoothedPlayersRef = useRef<Map<string, SmoothedPlayer>>(new Map())
  const smoothedEnemiesRef = useRef<Map<string, SmoothedEnemy>>(new Map())
  const smoothedCameraRef = useRef({ x: 0, y: 0 })
  const grassSpriteRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    worldRef.current = world
  }, [world])

  useEffect(() => {
    selfConnectionIdRef.current = selfConnectionId
  }, [selfConnectionId])

  useEffect(() => {
    sessionUserIdRef.current = session?.user?.id ?? null
  }, [session?.user?.id])

  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  useEffect(() => {
    const stored = window.localStorage.getItem(PLAYER_COLOR_STORAGE_KEY)
    const normalized = stored ? normalizeHexColor(stored) : null
    if (!normalized) {
      return
    }

    setSelectedColor(normalized)
    setSettingsColor(normalized)
    preferredColorRef.current = normalized
  }, [])

  useEffect(() => {
    preferredColorRef.current = selectedColor
  }, [selectedColor])

  useEffect(() => {
    let cancelled = false
    const texture = new Image()
    texture.decoding = 'async'
    texture.src = GRASS_TEXTURE_URL

    texture.onload = () => {
      if (cancelled) {
        return
      }

      const sprite = document.createElement('canvas')
      sprite.width = GRASS_SIZE
      sprite.height = GRASS_SIZE
      const spriteCtx = sprite.getContext('2d')
      if (!spriteCtx) {
        return
      }
      spriteCtx.imageSmoothingEnabled = true
      spriteCtx.drawImage(texture, 0, 0, GRASS_SIZE, GRASS_SIZE)
      grassSpriteRef.current = sprite
    }

    texture.onerror = () => {
      if (!cancelled) {
        grassSpriteRef.current = null
      }
    }

    return () => {
      cancelled = true
      grassSpriteRef.current = null
    }
  }, [])

  useEffect(() => {
    const updateSize = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    updateSize()
    window.addEventListener('resize', updateSize)
    return () => {
      window.removeEventListener('resize', updateSize)
    }
  }, [])

  useEffect(() => {
    if (!session?.user) {
      socketRef.current?.close()
      socketRef.current = null
      setWorld(null)
      setSelfConnectionId(null)
      setSocketStatus('disconnected')
      setSocketError(null)
      touchVectorRef.current = { dx: 0, dy: 0 }
      touchPointerIdRef.current = null
      setTouchStick({ active: false, x: 0, y: 0 })
      setSettingsOpen(false)
      setJoinCountdownMs(0)
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socketUrl = `${protocol}://${window.location.host}/ws/game`

    setSocketStatus('connecting')
    setSocketError(null)

    const socket = new WebSocket(socketUrl)
    socketRef.current = socket

    socket.onopen = () => {
      setSocketStatus('connected')
      setJoinCountdownMs(CLIENT_JOIN_DELAY_MS)
      const preferredColor = normalizeHexColor(preferredColorRef.current)
      if (preferredColor) {
        const payload: ClientToServerMessage = {
          type: 'set-color',
          color: preferredColor,
        }
        socket.send(JSON.stringify(payload))
      }
    }

    socket.onmessage = (event) => {
      let message: ServerToClientMessage
      try {
        message = JSON.parse(event.data) as ServerToClientMessage
      } catch {
        setSocketError('Received malformed realtime payload.')
        return
      }

      if (message.type === 'connected') {
        setSelfConnectionId(message.connectionId)
        setJoinCountdownMs(0)
        return
      }

      if (message.type === 'world-state') {
        setWorld(message.world)
        return
      }

      if (message.type === 'error') {
        setSocketError(message.message)
      }
    }

    socket.onerror = () => {
      setSocketStatus('error')
      setSocketError('WebSocket connection failed.')
    }

    socket.onclose = () => {
      setSocketStatus((status) => (status === 'error' ? 'error' : 'disconnected'))
      setJoinCountdownMs(0)
    }

    return () => {
      socket.close()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [session?.user])

  useEffect(() => {
    if (!session?.user || selfConnectionId || joinCountdownMs <= 0) {
      return
    }

    const interval = window.setInterval(() => {
      setJoinCountdownMs((current) => Math.max(0, current - 100))
    }, 100)

    return () => {
      window.clearInterval(interval)
    }
  }, [session?.user, selfConnectionId, joinCountdownMs])

  useEffect(() => {
    if (!session?.user) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (
        key === 'arrowup' ||
        key === 'arrowdown' ||
        key === 'arrowleft' ||
        key === 'arrowright' ||
        key === 'w' ||
        key === 'a' ||
        key === 's' ||
        key === 'd'
      ) {
        event.preventDefault()
        pressedKeysRef.current.add(key)
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      pressedKeysRef.current.delete(event.key.toLowerCase())
    }

    const interval = window.setInterval(() => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return
      }

      const keys = pressedKeysRef.current
      let keyDx = 0
      let keyDy = 0

      if (keys.has('arrowleft') || keys.has('a')) {
        keyDx -= 1
      }
      if (keys.has('arrowright') || keys.has('d')) {
        keyDx += 1
      }
      if (keys.has('arrowup') || keys.has('w')) {
        keyDy -= 1
      }
      if (keys.has('arrowdown') || keys.has('s')) {
        keyDy += 1
      }

      const touchVector = touchVectorRef.current
      const dx = clamp(keyDx + touchVector.dx, -1, 1)
      const dy = clamp(keyDy + touchVector.dy, -1, 1)

      if (dx === 0 && dy === 0) {
        return
      }

      const payload: ClientToServerMessage = {
        type: 'move',
        dx,
        dy,
      }
      socket.send(JSON.stringify(payload))
    }, 16)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      pressedKeysRef.current.clear()
    }
  }, [session?.user])

  useEffect(() => {
    if (!session?.user) {
      return
    }

    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) {
      return
    }

    let animationFrame = 0
    let frames = 0
    let fpsStart = performance.now()
    let lastFrameTime = performance.now()
    let dpr = Math.min(2, window.devicePixelRatio || 1)

    const drawGrass = (screenX: number, screenY: number) => {
      const sprite = grassSpriteRef.current
      if (sprite) {
        ctx.drawImage(sprite, screenX - GRASS_SIZE / 2, screenY - GRASS_SIZE / 2)
        return
      }

      const half = GRASS_SIZE / 2
      ctx.save()
      ctx.translate(screenX, screenY)
      ctx.shadowColor = 'rgba(163,230,53,0.7)'
      ctx.shadowBlur = 18
      ctx.fillStyle = '#7ed94d'
      ctx.fillRect(-half, -half, GRASS_SIZE, GRASS_SIZE)
      ctx.shadowBlur = 0
      ctx.strokeStyle = '#d9f99d'
      ctx.lineWidth = 2
      ctx.strokeRect(-half, -half, GRASS_SIZE, GRASS_SIZE)

      ctx.fillStyle = '#dcfce7'
      ctx.fillRect(-half + 2, -half - 11, 4, 11)
      ctx.fillRect(-half + 10, -half - 13, 4, 13)
      ctx.fillRect(-half + 18, -half - 11, 4, 11)
      ctx.fillRect(-half + 25, -half - 13, 4, 13)
      ctx.fillRect(-half + 31, -half - 11, 4, 11)
      ctx.restore()
    }

    const drawPowerup = (screenX: number, screenY: number, type: PowerupType) => {
      const half = POWERUP_SIZE / 2
      ctx.save()
      ctx.translate(screenX, screenY)
      ctx.shadowBlur = 14

      if (type === 'speed') {
        ctx.shadowColor = 'rgba(16,185,129,0.7)'
        ctx.fillStyle = '#10b981'
        ctx.beginPath()
        ctx.arc(0, 0, half, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#ecfeff'
        ctx.beginPath()
        ctx.moveTo(-3, -11)
        ctx.lineTo(3, -11)
        ctx.lineTo(-2, -1)
        ctx.lineTo(5, -1)
        ctx.lineTo(-6, 11)
        ctx.lineTo(-2, 3)
        ctx.lineTo(-8, 3)
        ctx.closePath()
        ctx.fill()
      } else if (type === 'magnet') {
        ctx.shadowColor = 'rgba(249,115,22,0.75)'
        ctx.fillStyle = '#f97316'
        ctx.beginPath()
        ctx.arc(0, 0, half, 0, Math.PI * 2)
        ctx.fill()

        ctx.strokeStyle = '#fff7ed'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(-7, -6)
        ctx.lineTo(-7, 4)
        ctx.arc(0, 4, 7, Math.PI, 0, false)
        ctx.lineTo(7, -6)
        ctx.stroke()
      } else {
        ctx.shadowColor = 'rgba(250,204,21,0.8)'
        ctx.fillStyle = '#facc15'
        ctx.beginPath()
        ctx.arc(0, 0, half, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#422006'
        ctx.font = '700 11px ui-sans-serif, system-ui, -apple-system, Segoe UI'
        ctx.textAlign = 'center'
        ctx.fillText('x2', 0, 4)
      }

      ctx.shadowBlur = 0
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(0, 0, half, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }

    const drawEnemy = (screenX: number, screenY: number) => {
      const half = ENEMY_SIZE / 2
      ctx.save()
      ctx.translate(Math.round(screenX), Math.round(screenY))
      ctx.shadowColor = 'rgba(239,68,68,0.7)'
      ctx.shadowBlur = 16

      ctx.fillStyle = '#ef4444'
      ctx.fillRect(-half, -half, ENEMY_SIZE, ENEMY_SIZE)
      ctx.shadowBlur = 0
      ctx.strokeStyle = '#fee2e2'
      ctx.lineWidth = 2
      ctx.strokeRect(-half, -half, ENEMY_SIZE, ENEMY_SIZE)

      ctx.fillStyle = '#111827'
      ctx.fillRect(-half + 6, -half + 6, ENEMY_SIZE - 12, ENEMY_SIZE - 18)
      ctx.fillStyle = '#34d399'
      ctx.fillRect(-half + 9, -half + 9, ENEMY_SIZE - 18, ENEMY_SIZE - 24)

      ctx.fillStyle = '#7f1d1d'
      ctx.fillRect(-half + 4, half - 10, ENEMY_SIZE - 8, 6)
      ctx.restore()
    }

    const drawStreet = (street: RectSnapshot, worldOriginX: number, worldOriginY: number) => {
      const screenX = street.x - worldOriginX
      const screenY = street.y - worldOriginY
      const endX = screenX + street.width
      const endY = screenY + street.height

      if (endX < 0 || screenX > viewportRef.current.width || endY < 0 || screenY > viewportRef.current.height) {
        return
      }

      ctx.fillStyle = '#24343d'
      ctx.fillRect(screenX, screenY, street.width, street.height)

      ctx.strokeStyle = 'rgba(218,229,239,0.34)'
      ctx.lineWidth = 2
      ctx.setLineDash([14, 12])
      if (street.width > street.height) {
        const centerY = screenY + street.height * 0.5
        ctx.beginPath()
        ctx.moveTo(screenX, centerY)
        ctx.lineTo(screenX + street.width, centerY)
        ctx.stroke()
      } else {
        const centerX = screenX + street.width * 0.5
        ctx.beginPath()
        ctx.moveTo(centerX, screenY)
        ctx.lineTo(centerX, screenY + street.height)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    const drawBuilding = (building: RectSnapshot, worldOriginX: number, worldOriginY: number) => {
      const screenX = building.x - worldOriginX
      const screenY = building.y - worldOriginY
      const endX = screenX + building.width
      const endY = screenY + building.height

      if (endX < 0 || screenX > viewportRef.current.width || endY < 0 || screenY > viewportRef.current.height) {
        return
      }

      const roofInset = Math.min(20, building.width * 0.2, building.height * 0.2)
      ctx.fillStyle = '#3f5164'
      ctx.fillRect(screenX, screenY, building.width, building.height)

      ctx.fillStyle = '#54697f'
      ctx.fillRect(
        screenX + roofInset,
        screenY + roofInset,
        Math.max(10, building.width - roofInset * 2),
        Math.max(10, building.height - roofInset * 2),
      )

      ctx.strokeStyle = '#1b2732'
      ctx.lineWidth = 2
      ctx.strokeRect(screenX, screenY, building.width, building.height)
    }

    const frame = (now: number) => {
      const deltaSeconds = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000))
      lastFrameTime = now
      const enemyLerp = 1 - Math.exp(-ENEMY_SMOOTHING_RATE * deltaSeconds)

      const { width, height } = viewportRef.current
      if (width <= 0 || height <= 0) {
        animationFrame = requestAnimationFrame(frame)
        return
      }

      const targetDpr = Math.min(2, window.devicePixelRatio || 1)
      if (targetDpr !== dpr) {
        dpr = targetDpr
      }

      const pixelWidth = Math.max(1, Math.floor(width * dpr))
      const pixelHeight = Math.max(1, Math.floor(height * dpr))
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#0f2c1b'
      ctx.fillRect(0, 0, width, height)

      const worldState = worldRef.current
      if (worldState) {
        const worldPlayers = worldState.players
        const userId = sessionUserIdRef.current

        let resolvedSelfId = selfConnectionIdRef.current
        if (!resolvedSelfId && userId) {
          const byUser = worldPlayers.find((player) => player.userId === userId)
          if (byUser) {
            resolvedSelfId = byUser.connectionId
            selfConnectionIdRef.current = byUser.connectionId
          }
        }

        const selfPlayer =
          (resolvedSelfId
            ? worldPlayers.find((player) => player.connectionId === resolvedSelfId)
            : undefined) ??
          (userId
            ? worldPlayers.find((player) => player.userId === userId)
            : undefined) ??
          null

        const halfW = width / 2
        const halfH = height / 2

        const targetCameraX = selfPlayer?.x ?? worldState.map.width / 2
        const targetCameraY = selfPlayer?.y ?? worldState.map.height / 2

        const minCamX = halfW
        const maxCamX = Math.max(halfW, worldState.map.width - halfW)
        const minCamY = halfH
        const maxCamY = Math.max(halfH, worldState.map.height - halfH)

        const clampedTargetX = clamp(targetCameraX, minCamX, maxCamX)
        const clampedTargetY = clamp(targetCameraY, minCamY, maxCamY)

        const camera = smoothedCameraRef.current
        if (camera.x === 0 && camera.y === 0) {
          camera.x = clampedTargetX
          camera.y = clampedTargetY
        } else {
          camera.x += (clampedTargetX - camera.x) * CAMERA_LERP
          camera.y += (clampedTargetY - camera.y) * CAMERA_LERP
        }

        const worldOriginX = camera.x - halfW
        const worldOriginY = camera.y - halfH

        for (const street of worldState.streets) {
          drawStreet(street, worldOriginX, worldOriginY)
        }

        for (const building of worldState.buildings) {
          drawBuilding(building, worldOriginX, worldOriginY)
        }

        const grassCull = GRASS_SIZE
        for (const grass of worldState.grasses) {
          const screenX = grass.x - worldOriginX
          const screenY = grass.y - worldOriginY

          if (
            screenX < -grassCull ||
            screenX > width + grassCull ||
            screenY < -grassCull ||
            screenY > height + grassCull
          ) {
            continue
          }

          drawGrass(screenX, screenY)
        }

        const powerupCull = POWERUP_SIZE
        for (const powerup of worldState.powerups) {
          const screenX = powerup.x - worldOriginX
          const screenY = powerup.y - worldOriginY

          if (
            screenX < -powerupCull ||
            screenX > width + powerupCull ||
            screenY < -powerupCull ||
            screenY > height + powerupCull
          ) {
            continue
          }

          drawPowerup(screenX, screenY, powerup.type)
        }

        const smoothedEnemies = smoothedEnemiesRef.current
        const activeEnemyIds = new Set<string>()
        for (const enemy of worldState.enemies) {
          activeEnemyIds.add(enemy.id)
          const current = smoothedEnemies.get(enemy.id)
          if (!current) {
            smoothedEnemies.set(enemy.id, { x: enemy.x, y: enemy.y })
            continue
          }

          current.x += (enemy.x - current.x) * enemyLerp
          current.y += (enemy.y - current.y) * enemyLerp
          if (Math.abs(enemy.x - current.x) < 0.02) {
            current.x = enemy.x
          }
          if (Math.abs(enemy.y - current.y) < 0.02) {
            current.y = enemy.y
          }
        }

        for (const id of smoothedEnemies.keys()) {
          if (!activeEnemyIds.has(id)) {
            smoothedEnemies.delete(id)
          }
        }

        const enemyCull = ENEMY_SIZE
        for (const enemy of smoothedEnemies.values()) {
          const screenX = enemy.x - worldOriginX
          const screenY = enemy.y - worldOriginY

          if (
            screenX < -enemyCull ||
            screenX > width + enemyCull ||
            screenY < -enemyCull ||
            screenY > height + enemyCull
          ) {
            continue
          }

          drawEnemy(screenX, screenY)
        }

        const smoothedPlayers = smoothedPlayersRef.current
        const activeIds = new Set<string>()

        for (const player of worldPlayers) {
          activeIds.add(player.connectionId)
          const current = smoothedPlayers.get(player.connectionId)
          if (!current) {
            smoothedPlayers.set(player.connectionId, {
              x: player.x,
              y: player.y,
              name: player.name,
              color: player.color,
              score: player.score,
              userId: player.userId,
              activePowerups: player.activePowerups,
            })
            continue
          }

          current.x += (player.x - current.x) * PLAYER_LERP
          current.y += (player.y - current.y) * PLAYER_LERP
          current.name = player.name
          current.color = player.color
          current.score = player.score
          current.userId = player.userId
          current.activePowerups = player.activePowerups
        }

        for (const id of smoothedPlayers.keys()) {
          if (!activeIds.has(id)) {
            smoothedPlayers.delete(id)
          }
        }

        ctx.textAlign = 'center'
        ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, Segoe UI'
        ctx.lineWidth = 2

        for (const [connectionId, player] of smoothedPlayers) {
          const screenX = player.x - worldOriginX
          const screenY = player.y - worldOriginY
          const cull = PLAYER_RADIUS + 30
          if (
            screenX < -cull ||
            screenX > width + cull ||
            screenY < -cull ||
            screenY > height + cull
          ) {
            continue
          }

          ctx.beginPath()
          ctx.arc(screenX, screenY, PLAYER_RADIUS, 0, Math.PI * 2)
          ctx.fillStyle = player.color
          ctx.fill()

          const isSelf = resolvedSelfId
            ? connectionId === resolvedSelfId
            : player.userId === userId

          if (player.activePowerups.length > 0) {
            if (player.activePowerups.includes('speed')) {
              ctx.strokeStyle = 'rgba(16,185,129,0.95)'
              ctx.lineWidth = 2
              ctx.beginPath()
              ctx.arc(screenX, screenY, PLAYER_RADIUS + 5, 0, Math.PI * 2)
              ctx.stroke()
            }
            if (player.activePowerups.includes('magnet')) {
              ctx.save()
              ctx.strokeStyle = 'rgba(249,115,22,0.95)'
              ctx.lineWidth = 2
              ctx.setLineDash([5, 4])
              ctx.beginPath()
              ctx.arc(screenX, screenY, PLAYER_RADIUS + 9, 0, Math.PI * 2)
              ctx.stroke()
              ctx.restore()
            }
            if (player.activePowerups.includes('double')) {
              ctx.strokeStyle = 'rgba(250,204,21,0.95)'
              ctx.lineWidth = 2
              ctx.beginPath()
              ctx.arc(screenX, screenY, PLAYER_RADIUS + 13, 0, Math.PI * 2)
              ctx.stroke()
            }
          }

          ctx.strokeStyle = isSelf ? '#ffffff' : '#111827'
          ctx.lineWidth = isSelf ? 3 : 2
          ctx.stroke()

          const label = `${player.name} (${player.score})`
          const labelWidth = ctx.measureText(label).width + 12
          const labelX = screenX - labelWidth / 2
          const labelY = screenY + PLAYER_RADIUS + 7
          ctx.fillStyle = 'rgba(0,0,0,0.7)'
          ctx.fillRect(labelX, labelY, labelWidth, 16)
          ctx.fillStyle = '#e7ffe8'
          ctx.fillText(label, screenX, labelY + 12)
        }
      }

      frames += 1
      const elapsed = now - fpsStart
      if (elapsed >= 250) {
        const nextFps = Math.round((frames * 1000) / elapsed)
        setFps(nextFps)
        frames = 0
        fpsStart = now
      }

      animationFrame = requestAnimationFrame(frame)
    }

    animationFrame = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(animationFrame)
      smoothedPlayersRef.current.clear()
      smoothedEnemiesRef.current.clear()
      smoothedCameraRef.current = { x: 0, y: 0 }
    }
  }, [session?.user])

  const leaderboard = useMemo(() => {
    if (!world) {
      return []
    }

    return [...world.players].sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      return a.name.localeCompare(b.name)
    })
  }, [world])

  const selfPlayer = useMemo(() => {
    if (!world) {
      return null
    }

    return (
      (selfConnectionId
        ? world.players.find((player) => player.connectionId === selfConnectionId)
        : undefined) ??
      (session?.user?.id
        ? world.players.find((player) => player.userId === session.user.id)
        : undefined) ??
      null
    )
  }, [world, selfConnectionId, session?.user?.id])

  const selfActivePowerups = selfPlayer?.activePowerups ?? []
  const joinCountdownSeconds = Math.max(1, Math.ceil(joinCountdownMs / 1000))
  const showWelcomeModal =
    socketStatus === 'connected' && !selfConnectionId && joinCountdownMs > 0

  useEffect(() => {
    const normalized = selfPlayer?.color ? normalizeHexColor(selfPlayer.color) : null
    if (!normalized) {
      return
    }

    setSelectedColor((current) => (current === normalized ? current : normalized))
    setSettingsColor((current) => (current === normalized ? current : normalized))
    preferredColorRef.current = normalized
    window.localStorage.setItem(PLAYER_COLOR_STORAGE_KEY, normalized)
  }, [selfPlayer?.color])

  const updateTouchStick = (clientX: number, clientY: number) => {
    const origin = touchOriginRef.current
    const offsetX = clientX - origin.x
    const offsetY = clientY - origin.y
    const distance = Math.hypot(offsetX, offsetY)
    const limitedDistance = Math.min(distance, JOYSTICK_RADIUS)
    const angle = Math.atan2(offsetY, offsetX)

    const x = limitedDistance * Math.cos(angle)
    const y = limitedDistance * Math.sin(angle)

    const normalizedX = x / JOYSTICK_RADIUS
    const normalizedY = y / JOYSTICK_RADIUS
    const magnitude = Math.hypot(normalizedX, normalizedY)

    if (magnitude < JOYSTICK_DEADZONE) {
      touchVectorRef.current = { dx: 0, dy: 0 }
      setTouchStick({ active: true, x: 0, y: 0 })
    } else {
      touchVectorRef.current = { dx: normalizedX, dy: normalizedY }
      setTouchStick({ active: true, x, y })
    }
  }

  const resetTouchControl = () => {
    touchPointerIdRef.current = null
    touchVectorRef.current = { dx: 0, dy: 0 }
    setTouchStick({ active: false, x: 0, y: 0 })
  }

  const startTouchControl = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touchPointerIdRef.current !== null) {
      return
    }

    touchPointerIdRef.current = event.pointerId
    touchOriginRef.current = { x: event.clientX, y: event.clientY }
    touchVectorRef.current = { dx: 0, dy: 0 }
    setTouchStick({ active: true, x: 0, y: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveTouchControl = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touchPointerIdRef.current !== event.pointerId) {
      return
    }

    updateTouchStick(event.clientX, event.clientY)
    event.preventDefault()
  }

  const endTouchControl = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touchPointerIdRef.current !== event.pointerId) {
      return
    }

    resetTouchControl()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.preventDefault()
  }

  const handleTouchControlLostCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touchPointerIdRef.current !== event.pointerId) {
      return
    }

    resetTouchControl()
  }

  useEffect(() => {
    const handleWindowBlur = () => {
      resetTouchControl()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        resetTouchControl()
      }
    }

    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const sendColorUpdate = (color: string) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    const normalized = normalizeHexColor(color)
    if (!normalized) {
      return
    }

    const payload: ClientToServerMessage = {
      type: 'set-color',
      color: normalized,
    }
    socket.send(JSON.stringify(payload))
  }

  const openSettings = () => {
    const base = normalizeHexColor(selfPlayer?.color ?? selectedColor) ?? DEFAULT_PLAYER_COLOR
    setSettingsColor(base)
    setSettingsOpen(true)
  }

  const saveSettings = () => {
    const normalized = normalizeHexColor(settingsColor) ?? DEFAULT_PLAYER_COLOR
    setSelectedColor(normalized)
    setSettingsColor(normalized)
    preferredColorRef.current = normalized
    window.localStorage.setItem(PLAYER_COLOR_STORAGE_KEY, normalized)
    sendColorUpdate(normalized)
    setSettingsOpen(false)
  }

  async function onAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthPending(true)
    setAuthError(null)

    const endpoint =
      authMode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email'
    const payload =
      authMode === 'signup'
        ? { name, email, password, rememberMe: true }
        : { email, password, rememberMe: true }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const result = (await response.json().catch(() => null)) as
        | { message?: string }
        | null

      if (!response.ok) {
        setAuthError(result?.message ?? 'Authentication failed.')
        return
      }

      const normalizedColor = normalizeHexColor(selectedColor)
      if (normalizedColor) {
        window.localStorage.setItem(PLAYER_COLOR_STORAGE_KEY, normalizedColor)
      }
      window.location.reload()
    } catch {
      setAuthError('Unable to reach auth server.')
    } finally {
      setAuthPending(false)
    }
  }

  if (sessionPending || !session?.user) {
    return (
      <main className="fixed inset-0 overflow-hidden bg-[radial-gradient(circle_at_20%_20%,#1f6f3b_0%,#0d2417_55%,#08140e_100%)] text-emerald-50">
        <div className="absolute inset-0 opacity-40" style={TILE_STYLE} />
        <div className="relative z-10 min-h-full grid place-items-center p-6">
          <section className="w-full max-w-md rounded-2xl border border-emerald-400/30 bg-black/55 p-6 backdrop-blur-sm">
            <h1 className="text-3xl font-black tracking-tight">TouchGrass.city</h1>
            <p className="mt-2 text-sm text-emerald-200">
              Large multiplayer field with gimmicks. Chase grass, grab powerups, and
              stay ahead while computers chase you down.
            </p>

            {sessionPending ? (
              <p className="mt-6 text-sm text-emerald-200">Checking session...</p>
            ) : (
              <>
                <div className="mt-6 flex gap-2">
                  <button
                    onClick={() => setAuthMode('signup')}
                    className={`px-4 py-2 rounded-md text-sm font-semibold ${
                      authMode === 'signup'
                        ? 'bg-emerald-400 text-black'
                        : 'bg-emerald-950/60 text-emerald-200'
                    }`}
                    type="button"
                  >
                    Sign up
                  </button>
                  <button
                    onClick={() => setAuthMode('signin')}
                    className={`px-4 py-2 rounded-md text-sm font-semibold ${
                      authMode === 'signin'
                        ? 'bg-emerald-400 text-black'
                        : 'bg-emerald-950/60 text-emerald-200'
                    }`}
                    type="button"
                  >
                    Sign in
                  </button>
                </div>

                <form className="mt-4 grid gap-3" onSubmit={onAuthSubmit}>
                  {authMode === 'signup' ? (
                    <label className="grid gap-1">
                      <span className="text-sm text-emerald-200">Display name</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        required
                        minLength={2}
                        className="rounded-md border border-emerald-700 bg-zinc-950 px-3 py-2"
                        placeholder="Grass Hunter"
                      />
                    </label>
                  ) : null}

                  <label className="grid gap-1">
                    <span className="text-sm text-emerald-200">Email</span>
                    <input
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      type="email"
                      className="rounded-md border border-emerald-700 bg-zinc-950 px-3 py-2"
                      placeholder="you@example.com"
                    />
                  </label>

                  <label className="grid gap-1">
                    <span className="text-sm text-emerald-200">Password</span>
                    <input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      type="password"
                      minLength={8}
                      className="rounded-md border border-emerald-700 bg-zinc-950 px-3 py-2"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm text-emerald-200">Player color</span>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        value={selectedColor}
                        onChange={(event) => {
                          const normalized = normalizeHexColor(event.target.value)
                          if (normalized) {
                            setSelectedColor(normalized)
                          }
                        }}
                        className="h-10 w-14 cursor-pointer rounded border border-emerald-700 bg-zinc-950 p-1"
                      />
                      <span className="text-xs text-emerald-200">{selectedColor}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {COLOR_PRESETS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => setSelectedColor(color)}
                          className={`h-6 w-6 rounded-full border ${
                            selectedColor === color ? 'border-white' : 'border-emerald-900'
                          }`}
                          style={{ backgroundColor: color }}
                          aria-label={`Select color ${color}`}
                        />
                      ))}
                    </div>
                  </label>

                  {authError ? (
                    <p className="text-sm rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-red-200">
                      {authError}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={authPending}
                    className="mt-2 rounded-md bg-emerald-400 px-4 py-2 font-semibold text-black disabled:opacity-70"
                  >
                    {authPending
                      ? 'Working...'
                      : 'Go touch some grass'}
                  </button>
                </form>
              </>
            )}
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#0f2c1b] text-emerald-50">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
      />

      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/70" />

        <section className="pointer-events-auto absolute left-1/2 top-4 z-10 w-[min(90vw,440px)] -translate-x-1/2 rounded-xl border border-emerald-400/40 bg-black/60 px-3 py-2 backdrop-blur-sm md:w-auto md:px-4 md:py-3">
          <h2 className="text-center text-xs font-bold uppercase tracking-wide text-emerald-200 md:text-sm">
            Leaderboard
          </h2>
          <ol className="mt-2 max-h-28 space-y-1 overflow-y-auto text-xs md:min-w-[280px] md:max-h-none md:text-sm">
            {leaderboard.slice(0, 8).map((player, index) => (
              <li
                key={player.connectionId}
                className="flex items-center justify-between rounded-md bg-emerald-950/70 px-2 py-1"
              >
                <span>
                  {index + 1}. {player.name}
                </span>
                <span className="font-bold">{player.score}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="pointer-events-auto absolute left-4 top-4 hidden rounded-xl border border-emerald-400/40 bg-black/60 px-3 py-2 text-xs backdrop-blur-sm md:block">
          <p>Status: {socketStatus}</p>
          <p>Players: {world?.players.length ?? 0}</p>
          <p>Towers: {world?.buildings.length ?? 0}</p>
          <p>Powerups: {world?.powerups.length ?? 0}</p>
          <p>Computers: {world?.enemies.length ?? 0}</p>
          <p className={fps >= 60 ? 'text-emerald-200' : 'text-amber-300'}>
            FPS: {fps}
          </p>
          <p className="mt-1 text-emerald-100">
            Active:{' '}
            {selfActivePowerups.length > 0
              ? selfActivePowerups.map((effect) => POWERUP_LABELS[effect]).join(', ')
              : 'none'}
          </p>
          {socketError ? <p className="text-amber-300">{socketError}</p> : null}
        </section>

        <section className="absolute bottom-24 left-3 right-36 rounded-lg border border-emerald-400/40 bg-black/60 px-3 py-1.5 text-left text-[10px] leading-tight backdrop-blur-sm md:hidden">
          Controls: Joystick to move. Avoid towers/computers and stay on streets.
        </section>

        <section className="absolute bottom-3 left-1/2 hidden w-[min(92vw,460px)] -translate-x-1/2 rounded-lg border border-emerald-400/40 bg-black/60 px-3 py-1.5 text-[10px] leading-tight backdrop-blur-sm md:block md:bottom-4 md:w-auto md:max-w-[780px] md:rounded-xl md:px-4 md:py-2 md:text-sm">
          Controls: WASD / Arrows / Touch joystick. Stay on streets and avoid towers.
          20 territorial computers reset your score on touch.
        </section>

        <section className="absolute bottom-14 left-1/2 hidden w-[min(92vw,460px)] -translate-x-1/2 rounded-lg border border-emerald-400/40 bg-black/60 px-3 py-1 text-[10px] leading-tight backdrop-blur-sm md:block md:bottom-16 md:w-auto md:max-w-[780px] md:rounded-xl md:px-3 md:py-2 md:text-xs">
          Powerups: Speed = faster movement | Magnet = pulls nearby grass | 2x Points = double score
        </section>

        <section className="pointer-events-auto absolute bottom-40 right-3 z-20 flex gap-2 md:bottom-auto md:right-4 md:top-4">
          <button
            type="button"
            onClick={openSettings}
            className="rounded-md border border-emerald-300/50 bg-black/60 px-2.5 py-1.5 text-[11px] font-semibold backdrop-blur-sm hover:bg-black/70 md:px-3 md:py-2 md:text-xs"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={() => {
              void authClient.signOut()
            }}
            className="rounded-md border border-emerald-300/50 bg-black/60 px-2.5 py-1.5 text-[11px] font-semibold backdrop-blur-sm hover:bg-black/70 md:px-3 md:py-2 md:text-xs"
          >
            Sign out
          </button>
        </section>

        {showWelcomeModal ? (
          <section className="pointer-events-auto absolute inset-0 z-40 grid place-items-center bg-black/65 p-4">
            <div className="w-full max-w-md rounded-2xl border border-emerald-400/40 bg-[#06130d]/95 p-6 text-center backdrop-blur">
              <h3 className="text-2xl font-black tracking-tight">Welcome to TouchGrass.city</h3>
              <p className="mt-2 text-sm text-emerald-200">
                Calibrating your spawn zone...
              </p>
              <p className="mt-4 text-3xl font-black text-emerald-300">
                {joinCountdownSeconds}s
              </p>
              <p className="mt-2 text-xs text-emerald-200">
                Entering the field shortly
              </p>
            </div>
          </section>
        ) : null}

        {settingsOpen ? (
          <section className="pointer-events-auto absolute inset-0 z-30 grid place-items-center bg-black/60 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-emerald-400/40 bg-[#07160f]/95 p-5 backdrop-blur">
              <h3 className="text-lg font-bold">Player Settings</h3>
              <p className="mt-1 text-xs text-emerald-200">Choose your player color</p>

              <div className="mt-4 flex items-center gap-3">
                <input
                  type="color"
                  value={settingsColor}
                  onChange={(event) => {
                    const normalized = normalizeHexColor(event.target.value)
                    if (normalized) {
                      setSettingsColor(normalized)
                    }
                  }}
                  className="h-12 w-16 cursor-pointer rounded border border-emerald-700 bg-zinc-950 p-1"
                />
                <div className="text-sm">
                  <p>{settingsColor}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-emerald-200">Preview</span>
                    <span
                      className="inline-block h-4 w-4 rounded-full border border-white/50"
                      style={{ backgroundColor: settingsColor }}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {COLOR_PRESETS.map((color) => (
                  <button
                    key={`settings-${color}`}
                    type="button"
                    onClick={() => setSettingsColor(color)}
                    className={`h-7 w-7 rounded-full border ${
                      settingsColor === color ? 'border-white' : 'border-emerald-900'
                    }`}
                    style={{ backgroundColor: color }}
                    aria-label={`Select color ${color}`}
                  />
                ))}
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="rounded-md border border-emerald-300/50 bg-black/40 px-3 py-2 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveSettings}
                  className="rounded-md bg-emerald-400 px-3 py-2 text-xs font-semibold text-black"
                >
                  Save
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="pointer-events-auto absolute bottom-4 right-4 sm:bottom-6 sm:right-6">
          <div
            className="relative h-28 w-28 rounded-full border border-emerald-300/40 bg-black/45 backdrop-blur-sm touch-none"
            onPointerDown={startTouchControl}
            onPointerMove={moveTouchControl}
            onPointerUp={endTouchControl}
            onPointerCancel={endTouchControl}
            onLostPointerCapture={handleTouchControlLostCapture}
            style={{ touchAction: 'none' }}
          >
            <div className="absolute inset-4 rounded-full border border-emerald-300/20" />
            <div
              className={`absolute left-1/2 top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-100/60 bg-emerald-300/55 shadow-[0_0_12px_rgba(163,230,53,0.35)] transition-opacity ${
                touchStick.active ? 'opacity-100' : 'opacity-85'
              }`}
              style={{
                transform: touchStick.active
                  ? `translate(calc(-50% + ${touchStick.x}px), calc(-50% + ${touchStick.y}px))`
                  : 'translate(-50%, -50%)',
              }}
            />
          </div>
        </section>
      </div>
    </main>
  )
}
