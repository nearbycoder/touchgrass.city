import { createFileRoute } from '@tanstack/react-router'
import type { Hooks, Peer } from 'crossws'
import { eq, sql } from 'drizzle-orm'
import { db } from '#/db'
import { playerProfiles, playerScores } from '#/db/schema'
import { auth } from '#/lib/auth'
import {
  GRASS_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  type ClientToServerMessage,
  type EnemySnapshot,
  type PlayerSnapshot,
  type PowerupSnapshot,
  type PowerupType,
  type RectSnapshot,
  type ServerToClientMessage,
  type WorldState,
} from '#/lib/game-protocol'

interface PeerContext {
  userId: string
  name: string
}

interface SessionUser {
  id: string
  name?: string | null
  email?: string | null
}

interface ServerPlayer extends Omit<PlayerSnapshot, 'activePowerups'> {
  peer: Peer
  speedUntil: number
  magnetUntil: number
  doubleUntil: number
}

interface GrassSpot {
  x: number
  y: number
}

interface PowerupSpot extends PowerupSnapshot {}
interface EnemySpot extends EnemySnapshot {
  homeX: number
  homeY: number
  territoryRadius: number
}
interface CityLayout {
  streets: RectSnapshot[]
  buildings: RectSnapshot[]
}

const GRASS_COUNT = 220
const GRASS_PLAYER_PADDING = 8
const GRASS_SPACING = 6

const POWERUP_COUNT = 18
const POWERUP_RADIUS = 16
const POWERUP_PLAYER_PADDING = 20
const POWERUP_GRASS_PADDING = 10
const POWERUP_SPACING = 28
const POWERUP_TYPES: PowerupType[] = ['speed', 'magnet', 'double']

const SPEED_MULTIPLIER = 1.7
const MAGNET_EXTRA_RADIUS = 108
const MAGNET_PULL_PER_TICK = 8
const ENEMY_COUNT = 20
const ENEMY_RADIUS = 20
const ENEMY_SPEED_PER_TICK = 7
const ENEMY_TICK_INTERVAL_MS = 60
const ENEMY_RETURN_SPEED_MULTIPLIER = 1.2
const SPEED_DURATION_MS = 8_000
const MAGNET_DURATION_MS = 9_000
const DOUBLE_DURATION_MS = 10_000
const OVERGROWTH_THRESHOLD = 4
const OVERGROWTH_BONUS = 3
const JOIN_DELAY_MS = 5_000
const CITY_COLS = 8
const CITY_ROWS = 8
const STREET_WIDTH = 170
const BUILDING_MARGIN = 46

const players = new Map<string, ServerPlayer>()
const userScores = new Map<string, number>()
const userColors = new Map<string, string>()
const userScoreLoads = new Map<string, Promise<void>>()
const userColorLoads = new Map<string, Promise<void>>()
const pendingJoinTimers = new Map<string, ReturnType<typeof setTimeout>>()
const cityLayout = createCityLayout()
let powerups: PowerupSpot[] = []
let enemies: EnemySpot[] = []
let grasses = initializeGrass()
powerups = initializePowerups()
enemies = initializeEnemies()

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomPowerupType(): PowerupType {
  return POWERUP_TYPES[randomBetween(0, POWERUP_TYPES.length - 1)]
}

function seededUnit(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453123
  return value - Math.floor(value)
}

function createCityLayout(): CityLayout {
  const streets: RectSnapshot[] = []
  const buildings: RectSnapshot[] = []
  const blockWidth = (MAP_WIDTH - STREET_WIDTH * (CITY_COLS + 1)) / CITY_COLS
  const blockHeight = (MAP_HEIGHT - STREET_WIDTH * (CITY_ROWS + 1)) / CITY_ROWS

  for (let col = 0; col <= CITY_COLS; col++) {
    const x = col * (blockWidth + STREET_WIDTH)
    streets.push({
      id: `street-v-${col}`,
      x,
      y: 0,
      width: STREET_WIDTH,
      height: MAP_HEIGHT,
    })
  }

  for (let row = 0; row <= CITY_ROWS; row++) {
    const y = row * (blockHeight + STREET_WIDTH)
    streets.push({
      id: `street-h-${row}`,
      x: 0,
      y,
      width: MAP_WIDTH,
      height: STREET_WIDTH,
    })
  }

  for (let row = 0; row < CITY_ROWS; row++) {
    for (let col = 0; col < CITY_COLS; col++) {
      const blockX = STREET_WIDTH + col * (blockWidth + STREET_WIDTH)
      const blockY = STREET_WIDTH + row * (blockHeight + STREET_WIDTH)
      const usableWidth = Math.max(80, blockWidth - BUILDING_MARGIN * 2)
      const usableHeight = Math.max(80, blockHeight - BUILDING_MARGIN * 2)
      const seedBase = row * 101 + col * 37 + 1
      const widthFactor = 0.52 + seededUnit(seedBase) * 0.3
      const heightFactor = 0.5 + seededUnit(seedBase + 1) * 0.34
      const mainWidth = usableWidth * widthFactor
      const mainHeight = usableHeight * heightFactor
      const offsetX = (usableWidth - mainWidth) * seededUnit(seedBase + 2)
      const offsetY = (usableHeight - mainHeight) * seededUnit(seedBase + 3)

      buildings.push({
        id: `tower-main-${row}-${col}`,
        x: blockX + BUILDING_MARGIN + offsetX,
        y: blockY + BUILDING_MARGIN + offsetY,
        width: mainWidth,
        height: mainHeight,
      })

      if (seededUnit(seedBase + 4) > 0.35) {
        const corner = Math.floor(seededUnit(seedBase + 5) * 4)
        const annexWidth = Math.max(60, usableWidth * (0.2 + seededUnit(seedBase + 6) * 0.22))
        const annexHeight = Math.max(60, usableHeight * (0.2 + seededUnit(seedBase + 7) * 0.22))
        let annexX = blockX + BUILDING_MARGIN
        let annexY = blockY + BUILDING_MARGIN

        if (corner === 1) {
          annexX += usableWidth - annexWidth
        } else if (corner === 2) {
          annexY += usableHeight - annexHeight
        } else if (corner === 3) {
          annexX += usableWidth - annexWidth
          annexY += usableHeight - annexHeight
        }

        buildings.push({
          id: `tower-annex-${row}-${col}`,
          x: annexX,
          y: annexY,
          width: annexWidth,
          height: annexHeight,
        })
      }
    }
  }

  return { streets, buildings }
}

function sanitizeColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

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

function colorFromUser(userId: string) {
  let hash = 0
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 75% 55%)`
}

function getUserColor(userId: string) {
  return userColors.get(userId) ?? colorFromUser(userId)
}

function sanitizeName(user: SessionUser) {
  const trimmed = user.name?.trim()
  if (trimmed) {
    return trimmed
  }
  const fallback = user.email?.split('@')[0]?.trim()
  if (fallback) {
    return fallback
  }
  return 'Player'
}

function circleIntersectsRect(
  x: number,
  y: number,
  radius: number,
  rect: Pick<RectSnapshot, 'x' | 'y' | 'width' | 'height'>,
) {
  const closestX = clamp(x, rect.x, rect.x + rect.width)
  const closestY = clamp(y, rect.y, rect.y + rect.height)
  const dx = x - closestX
  const dy = y - closestY
  return dx * dx + dy * dy <= radius * radius
}

function isCircleBlockedByBuildings(x: number, y: number, radius: number) {
  return cityLayout.buildings.some((building) => circleIntersectsRect(x, y, radius, building))
}

function resolveBlockedMovement(
  currentX: number,
  currentY: number,
  targetX: number,
  targetY: number,
  radius: number,
) {
  const boundedTargetX = clamp(targetX, radius, MAP_WIDTH - radius)
  const boundedTargetY = clamp(targetY, radius, MAP_HEIGHT - radius)
  const tryOrder = (order: 'xy' | 'yx') => {
    let nextX = currentX
    let nextY = currentY

    if (order === 'xy') {
      if (!isCircleBlockedByBuildings(boundedTargetX, currentY, radius)) {
        nextX = boundedTargetX
      }
      if (!isCircleBlockedByBuildings(nextX, boundedTargetY, radius)) {
        nextY = boundedTargetY
      }
    } else {
      if (!isCircleBlockedByBuildings(currentX, boundedTargetY, radius)) {
        nextY = boundedTargetY
      }
      if (!isCircleBlockedByBuildings(boundedTargetX, nextY, radius)) {
        nextX = boundedTargetX
      }
    }

    const movedX = nextX - currentX
    const movedY = nextY - currentY
    return { x: nextX, y: nextY, movedSquared: movedX * movedX + movedY * movedY }
  }

  const xy = tryOrder('xy')
  const yx = tryOrder('yx')
  return xy.movedSquared >= yx.movedSquared ? xy : yx
}

function spawnGrass(existing: GrassSpot[], skipIndex?: number): GrassSpot {
  const minX = GRASS_RADIUS
  const maxX = MAP_WIDTH - GRASS_RADIUS
  const minY = GRASS_RADIUS
  const maxY = MAP_HEIGHT - GRASS_RADIUS

  for (let i = 0; i < 32; i++) {
    const next = {
      x: randomBetween(minX, maxX),
      y: randomBetween(minY, maxY),
    }

    const hasPlayerCollision = Array.from(players.values()).some((player) => {
      const dx = player.x - next.x
      const dy = player.y - next.y
      const minDistance = PLAYER_RADIUS + GRASS_RADIUS + GRASS_PLAYER_PADDING
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    const hasGrassCollision = existing.some((grassSpot, index) => {
      if (index === skipIndex) {
        return false
      }

      const dx = grassSpot.x - next.x
      const dy = grassSpot.y - next.y
      const minDistance = GRASS_RADIUS * 2 + GRASS_SPACING
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    const hasPowerupCollision = powerups.some((powerup) => {
      const dx = powerup.x - next.x
      const dy = powerup.y - next.y
      const minDistance = GRASS_RADIUS + POWERUP_RADIUS + POWERUP_GRASS_PADDING
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    const hasEnemyCollision = enemies.some((enemy) => {
      const dx = enemy.x - next.x
      const dy = enemy.y - next.y
      const minDistance = GRASS_RADIUS + ENEMY_RADIUS + GRASS_PLAYER_PADDING
      return dx * dx + dy * dy <= minDistance * minDistance
    })
    const hasBuildingCollision = isCircleBlockedByBuildings(next.x, next.y, GRASS_RADIUS)

    if (
      !hasPlayerCollision &&
      !hasGrassCollision &&
      !hasPowerupCollision &&
      !hasEnemyCollision &&
      !hasBuildingCollision
    ) {
      return next
    }
  }

  for (let i = 0; i < 32; i++) {
    const fallback = {
      x: randomBetween(minX, maxX),
      y: randomBetween(minY, maxY),
    }
    if (!isCircleBlockedByBuildings(fallback.x, fallback.y, GRASS_RADIUS)) {
      return fallback
    }
  }

  return { x: minX, y: minY }
}

function initializeGrass(): GrassSpot[] {
  const allGrass: GrassSpot[] = []
  for (let i = 0; i < GRASS_COUNT; i++) {
    allGrass.push(spawnGrass(allGrass))
  }
  return allGrass
}

function spawnPowerup(existing: PowerupSpot[], skipIndex?: number): PowerupSpot {
  const minX = POWERUP_RADIUS
  const maxX = MAP_WIDTH - POWERUP_RADIUS
  const minY = POWERUP_RADIUS
  const maxY = MAP_HEIGHT - POWERUP_RADIUS

  for (let i = 0; i < 32; i++) {
    const next = {
      x: randomBetween(minX, maxX),
      y: randomBetween(minY, maxY),
    }

    const hasPlayerCollision = Array.from(players.values()).some((player) => {
      const dx = player.x - next.x
      const dy = player.y - next.y
      const minDistance = PLAYER_RADIUS + POWERUP_RADIUS + POWERUP_PLAYER_PADDING
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    const hasGrassCollision = grasses.some((grassSpot) => {
      const dx = grassSpot.x - next.x
      const dy = grassSpot.y - next.y
      const minDistance = GRASS_RADIUS + POWERUP_RADIUS + POWERUP_GRASS_PADDING
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    const hasPowerupCollision = existing.some((powerup, index) => {
      if (index === skipIndex) {
        return false
      }

      const dx = powerup.x - next.x
      const dy = powerup.y - next.y
      const minDistance = POWERUP_RADIUS * 2 + POWERUP_SPACING
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    const hasEnemyCollision = enemies.some((enemy) => {
      const dx = enemy.x - next.x
      const dy = enemy.y - next.y
      const minDistance = POWERUP_RADIUS + ENEMY_RADIUS + POWERUP_PLAYER_PADDING
      return dx * dx + dy * dy <= minDistance * minDistance
    })
    const hasBuildingCollision = isCircleBlockedByBuildings(next.x, next.y, POWERUP_RADIUS)

    if (
      !hasPlayerCollision &&
      !hasGrassCollision &&
      !hasPowerupCollision &&
      !hasEnemyCollision &&
      !hasBuildingCollision
    ) {
      return {
        id: crypto.randomUUID(),
        type: randomPowerupType(),
        x: next.x,
        y: next.y,
      }
    }
  }

  for (let i = 0; i < 32; i++) {
    const fallback = {
      x: randomBetween(minX, maxX),
      y: randomBetween(minY, maxY),
    }
    if (!isCircleBlockedByBuildings(fallback.x, fallback.y, POWERUP_RADIUS)) {
      return {
        id: crypto.randomUUID(),
        type: randomPowerupType(),
        x: fallback.x,
        y: fallback.y,
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    type: randomPowerupType(),
    x: minX,
    y: minY,
  }
}

function initializePowerups(): PowerupSpot[] {
  const allPowerups: PowerupSpot[] = []
  for (let i = 0; i < POWERUP_COUNT; i++) {
    allPowerups.push(spawnPowerup(allPowerups))
  }
  return allPowerups
}

function getEnemyHome(index: number) {
  const cols = Math.ceil(Math.sqrt(ENEMY_COUNT))
  const rows = Math.ceil(ENEMY_COUNT / cols)
  const col = index % cols
  const row = Math.floor(index / cols)
  const cellWidth = MAP_WIDTH / cols
  const cellHeight = MAP_HEIGHT / rows

  const jitterXRange = Math.max(20, Math.floor(cellWidth * 0.2))
  const jitterYRange = Math.max(20, Math.floor(cellHeight * 0.2))

  const homeX = clamp(
    Math.round((col + 0.5) * cellWidth + randomBetween(-jitterXRange, jitterXRange)),
    ENEMY_RADIUS,
    MAP_WIDTH - ENEMY_RADIUS,
  )
  const homeY = clamp(
    Math.round((row + 0.5) * cellHeight + randomBetween(-jitterYRange, jitterYRange)),
    ENEMY_RADIUS,
    MAP_HEIGHT - ENEMY_RADIUS,
  )
  const territoryRadius = Math.max(900, Math.floor(Math.min(cellWidth, cellHeight) * 0.8))

  const snapped = resolveBlockedMovement(homeX, homeY, homeX, homeY, ENEMY_RADIUS)
  if (!isCircleBlockedByBuildings(snapped.x, snapped.y, ENEMY_RADIUS)) {
    return { homeX: snapped.x, homeY: snapped.y, territoryRadius }
  }

  let closestStreetPoint = { x: homeX, y: homeY }
  let closestDistanceSquared = Number.POSITIVE_INFINITY
  for (const street of cityLayout.streets) {
    const pointX = clamp(homeX, street.x + ENEMY_RADIUS, street.x + street.width - ENEMY_RADIUS)
    const pointY = clamp(homeY, street.y + ENEMY_RADIUS, street.y + street.height - ENEMY_RADIUS)
    if (pointX < ENEMY_RADIUS || pointY < ENEMY_RADIUS) {
      continue
    }
    const dx = homeX - pointX
    const dy = homeY - pointY
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared < closestDistanceSquared) {
      closestDistanceSquared = distanceSquared
      closestStreetPoint = { x: pointX, y: pointY }
    }
  }

  return { homeX: closestStreetPoint.x, homeY: closestStreetPoint.y, territoryRadius }
}

function spawnEnemy(existing: EnemySpot[], enemyIndex: number): EnemySpot {
  const home = getEnemyHome(enemyIndex)

  for (let i = 0; i < 16; i++) {
    const spawnDistance = i === 0 ? 0 : randomBetween(0, Math.floor(home.territoryRadius * 0.4))
    const angle = (Math.PI * 2 * i) / 16
    const x = clamp(
      Math.round(home.homeX + Math.cos(angle) * spawnDistance),
      ENEMY_RADIUS,
      MAP_WIDTH - ENEMY_RADIUS,
    )
    const y = clamp(
      Math.round(home.homeY + Math.sin(angle) * spawnDistance),
      ENEMY_RADIUS,
      MAP_HEIGHT - ENEMY_RADIUS,
    )

    const hasEnemyCollision = existing.some((enemy) => {
      const dx = enemy.x - x
      const dy = enemy.y - y
      const minDistance = ENEMY_RADIUS * 2 + 28
      return dx * dx + dy * dy <= minDistance * minDistance
    })
    const hasBuildingCollision = isCircleBlockedByBuildings(x, y, ENEMY_RADIUS)

    if (!hasEnemyCollision && !hasBuildingCollision) {
      return {
        id: crypto.randomUUID(),
        x,
        y,
        homeX: home.homeX,
        homeY: home.homeY,
        territoryRadius: home.territoryRadius,
      }
    }
  }

  for (let i = 0; i < 32; i++) {
    const randomStreet = cityLayout.streets[randomBetween(0, cityLayout.streets.length - 1)]
    const x = randomBetween(
      Math.ceil(randomStreet.x + ENEMY_RADIUS),
      Math.floor(randomStreet.x + randomStreet.width - ENEMY_RADIUS),
    )
    const y = randomBetween(
      Math.ceil(randomStreet.y + ENEMY_RADIUS),
      Math.floor(randomStreet.y + randomStreet.height - ENEMY_RADIUS),
    )
    const hasEnemyCollision = existing.some((enemy) => {
      const dx = enemy.x - x
      const dy = enemy.y - y
      const minDistance = ENEMY_RADIUS * 2 + 28
      return dx * dx + dy * dy <= minDistance * minDistance
    })

    if (!hasEnemyCollision && !isCircleBlockedByBuildings(x, y, ENEMY_RADIUS)) {
      return {
        id: crypto.randomUUID(),
        x,
        y,
        homeX: home.homeX,
        homeY: home.homeY,
        territoryRadius: home.territoryRadius,
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    x: home.homeX,
    y: home.homeY,
    homeX: home.homeX,
    homeY: home.homeY,
    territoryRadius: home.territoryRadius,
  }
}

function initializeEnemies(): EnemySpot[] {
  const allEnemies: EnemySpot[] = []
  for (let i = 0; i < ENEMY_COUNT; i++) {
    allEnemies.push(spawnEnemy(allEnemies, i))
  }
  return allEnemies
}

function spawnPlayerPosition() {
  for (let i = 0; i < 32; i++) {
    const x = randomBetween(PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS)
    const y = randomBetween(PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS)

    const hasEnemyCollision = enemies.some((enemy) => {
      const dx = enemy.x - x
      const dy = enemy.y - y
      const minDistance = PLAYER_RADIUS + ENEMY_RADIUS + 60
      return dx * dx + dy * dy <= minDistance * minDistance
    })
    const hasBuildingCollision = isCircleBlockedByBuildings(x, y, PLAYER_RADIUS)

    if (!hasEnemyCollision && !hasBuildingCollision) {
      return { x, y }
    }
  }

  for (let i = 0; i < 64; i++) {
    const street = cityLayout.streets[randomBetween(0, cityLayout.streets.length - 1)]
    const minStreetX = Math.ceil(street.x + PLAYER_RADIUS)
    const maxStreetX = Math.floor(street.x + street.width - PLAYER_RADIUS)
    const minStreetY = Math.ceil(street.y + PLAYER_RADIUS)
    const maxStreetY = Math.floor(street.y + street.height - PLAYER_RADIUS)
    if (minStreetX > maxStreetX || minStreetY > maxStreetY) {
      continue
    }
    const x = randomBetween(minStreetX, maxStreetX)
    const y = randomBetween(minStreetY, maxStreetY)
    if (!isCircleBlockedByBuildings(x, y, PLAYER_RADIUS)) {
      return { x, y }
    }
  }

  return { x: PLAYER_RADIUS, y: PLAYER_RADIUS }
}

function extendPowerup(currentUntil: number, now: number, durationMs: number) {
  const base = currentUntil > now ? currentUntil : now
  return base + durationMs
}

function applyPowerup(player: ServerPlayer, type: PowerupType, now: number) {
  if (type === 'speed') {
    player.speedUntil = extendPowerup(player.speedUntil, now, SPEED_DURATION_MS)
    return
  }

  if (type === 'magnet') {
    player.magnetUntil = extendPowerup(player.magnetUntil, now, MAGNET_DURATION_MS)
    return
  }

  player.doubleUntil = extendPowerup(player.doubleUntil, now, DOUBLE_DURATION_MS)
}

function getActivePowerups(player: ServerPlayer, now: number): PowerupType[] {
  const active: PowerupType[] = []
  if (player.speedUntil > now) {
    active.push('speed')
  }
  if (player.magnetUntil > now) {
    active.push('magnet')
  }
  if (player.doubleUntil > now) {
    active.push('double')
  }
  return active
}

function getPlayerMoveSpeed(player: ServerPlayer, now: number) {
  return player.speedUntil > now ? PLAYER_SPEED * SPEED_MULTIPLIER : PLAYER_SPEED
}

function getGrassTouchRadius() {
  return PLAYER_RADIUS + GRASS_RADIUS
}

function getGrassMagnetRadius(player: ServerPlayer, now: number) {
  const base = getGrassTouchRadius()
  return player.magnetUntil > now ? base + MAGNET_EXTRA_RADIUS : base
}

function getWorldState(): WorldState {
  const now = Date.now()

  return {
    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
    },
    streets: cityLayout.streets,
    buildings: cityLayout.buildings,
    grasses,
    powerups,
    enemies: enemies.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      y: enemy.y,
    })),
    players: Array.from(players.values()).map((player) => ({
      connectionId: player.connectionId,
      userId: player.userId,
      name: player.name,
      color: player.color,
      x: player.x,
      y: player.y,
      score: player.score,
      activePowerups: getActivePowerups(player, now),
    })),
  }
}

function sendToPeer(peer: Peer, message: ServerToClientMessage) {
  peer.send(JSON.stringify(message))
}

function broadcastWorld() {
  const message: ServerToClientMessage = {
    type: 'world-state',
    world: getWorldState(),
  }

  for (const player of players.values()) {
    sendToPeer(player.peer, message)
  }
}

function applyScoreToConnectedPlayers(userId: string, score: number) {
  for (const connectedPlayer of players.values()) {
    if (connectedPlayer.userId === userId) {
      connectedPlayer.score = score
    }
  }
}

function applyColorToConnectedPlayers(userId: string, color: string) {
  for (const connectedPlayer of players.values()) {
    if (connectedPlayer.userId === userId) {
      connectedPlayer.color = color
    }
  }
}

async function hydrateUserScore(userId: string) {
  if (userScores.has(userId)) {
    return
  }

  const inFlight = userScoreLoads.get(userId)
  if (inFlight) {
    await inFlight
    return
  }

  const loadPromise = (async () => {
    try {
      const [row] = await db
        .select({ score: playerScores.score })
        .from(playerScores)
        .where(eq(playerScores.userId, userId))
        .limit(1)

      const persistedScore = row?.score ?? 0
      const existingScore = userScores.get(userId) ?? 0
      const mergedScore = Math.max(existingScore, persistedScore)
      userScores.set(userId, mergedScore)

      applyScoreToConnectedPlayers(userId, mergedScore)

      const hasConnectedPlayer = Array.from(players.values()).some(
        (connectedPlayer) => connectedPlayer.userId === userId,
      )
      if (hasConnectedPlayer) {
        broadcastWorld()
      }
    } catch (error) {
      console.error(`Failed to hydrate score for user ${userId}`, error)
    } finally {
      userScoreLoads.delete(userId)
    }
  })()

  userScoreLoads.set(userId, loadPromise)
  await loadPromise
}

async function hydrateUserColor(userId: string) {
  if (userColors.has(userId)) {
    return
  }

  const inFlight = userColorLoads.get(userId)
  if (inFlight) {
    await inFlight
    return
  }

  const loadPromise = (async () => {
    try {
      const [row] = await db
        .select({ color: playerProfiles.color })
        .from(playerProfiles)
        .where(eq(playerProfiles.userId, userId))
        .limit(1)

      const persistedColor = sanitizeColor(row?.color)
      const fallbackColor = colorFromUser(userId)
      const preferredColor = persistedColor ?? fallbackColor
      const mergedColor = userColors.get(userId) ?? preferredColor
      userColors.set(userId, mergedColor)

      applyColorToConnectedPlayers(userId, mergedColor)

      const hasConnectedPlayer = Array.from(players.values()).some(
        (connectedPlayer) => connectedPlayer.userId === userId,
      )
      if (hasConnectedPlayer) {
        broadcastWorld()
      }
    } catch (error) {
      console.error(`Failed to hydrate color for user ${userId}`, error)
    } finally {
      userColorLoads.delete(userId)
    }
  })()

  userColorLoads.set(userId, loadPromise)
  await loadPromise
}

async function persistScoreDelta(userId: string, delta: number) {
  if (delta <= 0) {
    return
  }

  try {
    await db
      .insert(playerScores)
      .values({
        userId,
        score: delta,
      })
      .onConflictDoUpdate({
        target: playerScores.userId,
        set: {
          score: sql`${playerScores.score} + ${delta}`,
          updatedAt: sql`now()`,
        },
      })
  } catch (error) {
    console.error(`Failed to persist score for user ${userId}`, error)
  }
}

async function persistUserScore(userId: string, score: number) {
  try {
    await db
      .insert(playerScores)
      .values({
        userId,
        score,
      })
      .onConflictDoUpdate({
        target: playerScores.userId,
        set: {
          score,
          updatedAt: sql`now()`,
        },
      })
  } catch (error) {
    console.error(`Failed to persist absolute score for user ${userId}`, error)
  }
}

async function persistUserColor(userId: string, color: string) {
  try {
    await db
      .insert(playerProfiles)
      .values({
        userId,
        color,
      })
      .onConflictDoUpdate({
        target: playerProfiles.userId,
        set: {
          color,
          updatedAt: sql`now()`,
        },
      })
  } catch (error) {
    console.error(`Failed to persist color for user ${userId}`, error)
  }
}

async function resolveUser(headers: Headers): Promise<SessionUser | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timedSession = Promise.race([
    auth.api.getSession({
      headers,
    }) as Promise<{ user?: SessionUser } | null>,
    new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), 1500)
    }),
  ])

  let session: { user?: SessionUser } | null
  try {
    session = await timedSession
  } catch {
    return null
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }

  if (!session?.user?.id) {
    return null
  }

  return session.user
}

function respawnPlayer(player: ServerPlayer) {
  const next = spawnPlayerPosition()
  player.x = next.x
  player.y = next.y
}

function resetUserScore(userId: string) {
  userScores.set(userId, 0)
  applyScoreToConnectedPlayers(userId, 0)
  void persistUserScore(userId, 0)
}

function movePointToward(
  currentX: number,
  currentY: number,
  targetX: number,
  targetY: number,
  maxStep: number,
) {
  const dx = targetX - currentX
  const dy = targetY - currentY
  const distanceSquared = dx * dx + dy * dy
  if (distanceSquared <= 0.0001) {
    return { x: currentX, y: currentY, moved: false, distanceSquared: 0 }
  }

  const distance = Math.sqrt(distanceSquared)
  const step = Math.min(maxStep, distance)
  const next = resolveBlockedMovement(
    currentX,
    currentY,
    currentX + (dx / distance) * step,
    currentY + (dy / distance) * step,
    ENEMY_RADIUS,
  )
  return { x: next.x, y: next.y, moved: next.movedSquared > 0.0001, distanceSquared }
}

function updateEnemies() {
  if (players.size === 0 || enemies.length === 0) {
    return false
  }

  const allPlayers = Array.from(players.values())
  const hitUserIds = new Set<string>()
  let changed = false

  for (const enemy of enemies) {
    const homeDx = enemy.homeX - enemy.x
    const homeDy = enemy.homeY - enemy.y
    const homeDistanceSquared = homeDx * homeDx + homeDy * homeDy
    const leashSquared = (enemy.territoryRadius * 1.35) ** 2

    let closestPlayer: ServerPlayer | null = null
    let closestDistanceSquared = Number.POSITIVE_INFINITY

    for (const player of allPlayers) {
      const dx = player.x - enemy.x
      const dy = player.y - enemy.y
      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared
        closestPlayer = player
      }
    }

    const shouldReturnHome = homeDistanceSquared > leashSquared || !closestPlayer
    const targetX = shouldReturnHome ? enemy.homeX : closestPlayer.x
    const targetY = shouldReturnHome ? enemy.homeY : closestPlayer.y
    const speed = shouldReturnHome
      ? ENEMY_SPEED_PER_TICK * ENEMY_RETURN_SPEED_MULTIPLIER
      : ENEMY_SPEED_PER_TICK

    const moved = movePointToward(enemy.x, enemy.y, targetX, targetY, speed)
    if (moved.moved) {
      enemy.x = moved.x
      enemy.y = moved.y
      changed = true
    }

    const hitDistanceSquared = (PLAYER_RADIUS + ENEMY_RADIUS) ** 2
    for (const player of allPlayers) {
      const dx = player.x - enemy.x
      const dy = player.y - enemy.y
      if (dx * dx + dy * dy <= hitDistanceSquared) {
        if (!hitUserIds.has(player.userId)) {
          hitUserIds.add(player.userId)
        }
        respawnPlayer(player)
        changed = true
      }
    }
  }

  for (const userId of hitUserIds) {
    resetUserScore(userId)
  }

  return changed || hitUserIds.size > 0
}

const enemyTickerGlobal = globalThis as typeof globalThis & {
  __touchgrassEnemyTicker?: ReturnType<typeof setInterval>
}

if (enemyTickerGlobal.__touchgrassEnemyTicker) {
  clearInterval(enemyTickerGlobal.__touchgrassEnemyTicker)
}

enemyTickerGlobal.__touchgrassEnemyTicker = setInterval(() => {
  const changed = updateEnemies()
  if (changed) {
    broadcastWorld()
  }
}, ENEMY_TICK_INTERVAL_MS)

const hooks: Partial<Hooks> = {
  async upgrade(request) {
    const user = await resolveUser(request.headers)
    if (!user) {
      return new Response('Unauthorized', { status: 401 })
    }

    return {
      context: {
        userId: user.id,
        name: sanitizeName(user),
      } satisfies PeerContext,
    }
  },

  open(peer) {
    const context = (peer.context ?? {}) as Partial<PeerContext>
    if (!context.userId) {
      peer.close(4401, 'Unauthorized')
      return
    }
    const userId = context.userId
    const displayName = context.name ?? 'Player'

    void hydrateUserScore(userId)
    void hydrateUserColor(userId)

    const timer = setTimeout(() => {
      const trackedTimer = pendingJoinTimers.get(peer.id)
      if (trackedTimer !== timer) {
        return
      }
      pendingJoinTimers.delete(peer.id)

      const persistedScore = userScores.get(userId) ?? 0
      const start = spawnPlayerPosition()
      const player: ServerPlayer = {
        peer,
        connectionId: peer.id,
        userId,
        name: displayName,
        color: getUserColor(userId),
        x: start.x,
        y: start.y,
        score: persistedScore,
        speedUntil: 0,
        magnetUntil: 0,
        doubleUntil: 0,
      }

      players.set(peer.id, player)
      sendToPeer(peer, {
        type: 'connected',
        connectionId: peer.id,
      })
      broadcastWorld()
    }, JOIN_DELAY_MS)

    pendingJoinTimers.set(peer.id, timer)
  },

  close(peer) {
    const pendingTimer = pendingJoinTimers.get(peer.id)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingJoinTimers.delete(peer.id)
    }

    const closedPlayer = players.get(peer.id)
    const hadPlayer = players.delete(peer.id)
    if (closedPlayer) {
      const hasOtherConnectionsForUser = Array.from(players.values()).some(
        (connectedPlayer) => connectedPlayer.userId === closedPlayer.userId,
      )
      if (!hasOtherConnectionsForUser) {
        userScores.delete(closedPlayer.userId)
        userColors.delete(closedPlayer.userId)
      }
    }
    if (hadPlayer) {
      broadcastWorld()
    }
  },

  message(peer, message) {
    const player = players.get(peer.id)
    if (!player) {
      return
    }

    let payload: ClientToServerMessage
    try {
      payload = message.json<ClientToServerMessage>()
    } catch {
      sendToPeer(peer, { type: 'error', message: 'Invalid message payload.' })
      return
    }

    if (payload.type === 'set-color') {
      const nextColor = sanitizeColor(payload.color)
      if (!nextColor) {
        sendToPeer(peer, { type: 'error', message: 'Invalid color format.' })
        return
      }

      userColors.set(player.userId, nextColor)
      applyColorToConnectedPlayers(player.userId, nextColor)
      void persistUserColor(player.userId, nextColor)
      broadcastWorld()
      return
    }

    if (payload.type !== 'move') {
      return
    }

    const now = Date.now()
    const dx = clamp(Number(payload.dx) || 0, -1, 1)
    const dy = clamp(Number(payload.dy) || 0, -1, 1)
    if (dx === 0 && dy === 0) {
      return
    }

    const diagonalScale = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1
    const moveSpeed = getPlayerMoveSpeed(player, now)
    const movedPlayer = resolveBlockedMovement(
      player.x,
      player.y,
      player.x + dx * moveSpeed * diagonalScale,
      player.y + dy * moveSpeed * diagonalScale,
      PLAYER_RADIUS,
    )
    player.x = movedPlayer.x
    player.y = movedPlayer.y

    const powerupTouchDistanceSquared = (PLAYER_RADIUS + POWERUP_RADIUS) ** 2
    for (let i = 0; i < powerups.length; i++) {
      const distanceX = player.x - powerups[i].x
      const distanceY = player.y - powerups[i].y
      if (distanceX * distanceX + distanceY * distanceY <= powerupTouchDistanceSquared) {
        applyPowerup(player, powerups[i].type, now)
        powerups[i] = spawnPowerup(powerups, i)
      }
    }

    const isMagnetActive = player.magnetUntil > now
    const touchingDistance = getGrassTouchRadius()
    const touchingDistanceSquared = touchingDistance ** 2
    const magnetDistanceSquared = getGrassMagnetRadius(player, now) ** 2
    let touchedGrassCount = 0
    for (let i = 0; i < grasses.length; i++) {
      let distanceX = player.x - grasses[i].x
      let distanceY = player.y - grasses[i].y
      let distanceSquared = distanceX * distanceX + distanceY * distanceY

      if (distanceSquared <= touchingDistanceSquared) {
        touchedGrassCount += 1
        grasses[i] = spawnGrass(grasses, i)
        continue
      }

      if (isMagnetActive && distanceSquared <= magnetDistanceSquared) {
        const distance = Math.sqrt(distanceSquared)
        if (distance > 0.001) {
          const pullAmount = Math.min(MAGNET_PULL_PER_TICK, Math.max(0, distance - touchingDistance))
          if (pullAmount > 0) {
            const pulledX = clamp(
              grasses[i].x + (distanceX / distance) * pullAmount,
              GRASS_RADIUS,
              MAP_WIDTH - GRASS_RADIUS,
            )
            const pulledY = clamp(
              grasses[i].y + (distanceY / distance) * pullAmount,
              GRASS_RADIUS,
              MAP_HEIGHT - GRASS_RADIUS,
            )
            if (!isCircleBlockedByBuildings(pulledX, pulledY, GRASS_RADIUS)) {
              grasses[i].x = pulledX
              grasses[i].y = pulledY
            }

            distanceX = player.x - grasses[i].x
            distanceY = player.y - grasses[i].y
            distanceSquared = distanceX * distanceX + distanceY * distanceY
          }
        }
      }

      if (distanceSquared <= touchingDistanceSquared) {
        touchedGrassCount += 1
        grasses[i] = spawnGrass(grasses, i)
      }
    }

    let pointsAwarded = touchedGrassCount
    if (pointsAwarded > 0 && player.doubleUntil > now) {
      pointsAwarded *= 2
    }
    if (touchedGrassCount >= OVERGROWTH_THRESHOLD) {
      pointsAwarded += OVERGROWTH_BONUS
    }

    if (pointsAwarded > 0) {
      const nextScore = (userScores.get(player.userId) ?? player.score) + pointsAwarded
      userScores.set(player.userId, nextScore)
      applyScoreToConnectedPlayers(player.userId, nextScore)
      void persistScoreDelta(player.userId, pointsAwarded)
    }

    updateEnemies()
    broadcastWorld()
  },
}

function websocketUpgradeResponse() {
  return Object.assign(
    new Response('WebSocket upgrade is required.', { status: 426 }),
    { crossws: hooks },
  )
}

function handler() {
  return websocketUpgradeResponse()
}

export const Route = createFileRoute('/ws/game')({
  server: {
    handlers: {
      GET: handler,
    },
  },
})
