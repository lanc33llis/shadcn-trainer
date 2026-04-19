import { promises as fs } from "fs"
import path from "path"
import puppeteer, { type Page } from "puppeteer"
import { encodePreset } from "../../../packages/shadcn/src/preset/index.ts"

import {
  BASES,
  BASE_COLORS,
  DEFAULT_CONFIG,
  MENU_ACCENTS,
  MENU_COLORS,
  RADII,
  STYLES,
  buildRegistryTheme,
  designSystemConfigSchema,
  fonts as registryFonts,
  getThemesForBaseColor,
  iconLibraries,
  type BaseColorName,
  type BaseName,
  type DesignSystemConfig,
  type FontValue,
  type IconLibraryName,
  type MenuAccentValue,
  type MenuColorValue,
  type RadiusValue,
  type StyleName,
  type ThemeName,
} from "@/registry/config"
import { type RandomizeContext } from "@/app/(create)/lib/randomize-biases"

const HELP_TEXT = `
Generate random theme/config screenshots for model training.

Usage:
  pnpm --filter=v4 theme-training:capture -- [options]

Options:
  --count <n>            Number of unique configs to generate. Default: 25
  --base-url <url>       Preview server URL. Default: http://localhost:4000
  --item <name>          Preview item to render. Default: preview
  --base <name>          Restrict samples to one base (radix|base)
  --viewports <list>     Comma-separated viewport presets. Default: compact,desktop
  --qualities <list>     Comma-separated JPEG qualities. Default: 95
  --appearances <list>   light,dark or a subset. Default: light,dark
  --output-dir <path>    Dataset output directory. Default: temp/theme-training/<timestamp>
  --seed <n>             Seed for repeatable sampling. Default: current timestamp
  --force                Remove the output directory before writing
  --help                 Show this message

Outputs:
  manifest.json         Canonical dataset index with samples, screens, captures, and file paths
  manifest.jsonl        One line per image capture for easy streaming/ETL
  dataset.json          Lightweight dataset summary
  samples/<id>/         Per-sample config/theme/tokens/target plus per-screen artifacts

Viewport presets:
  compact  -> 640x1100 @1x, exported smaller
  desktop  -> 1440x1200 @1x, exported smaller
  retina   -> 1440x1200 @1.5x, exported smaller
`.trim()

const DATASET_SCHEMA_VERSION = "synth-theme-dataset.v1"
const WAIT_AFTER_RELOAD_MS = 150
const DEFAULT_COUNT = 25
const DEFAULT_BASE_URL = "http://localhost:4000"
const DEFAULT_ITEM = "preview"
const DEFAULT_APPEARANCES = ["light", "dark"] as const
const DEFAULT_VIEWPORTS = ["compact", "desktop"] as const
const DEFAULT_QUALITIES = [95] as const
const RTL_PROBABILITY = 0.35

const VIEWPORT_PRESETS = {
  compact: {
    name: "compact",
    width: 640,
    height: 1100,
    deviceScaleFactor: 1,
    captureScale: 0.4,
  },
  desktop: {
    name: "desktop",
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
    captureScale: 0.48,
  },
  retina: {
    name: "retina",
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1.5,
    captureScale: 0.32,
  },
} as const

const SPACING_STEPS = [
  { key: "1", multiplier: 1 },
  { key: "1_5", multiplier: 1.5 },
  { key: "2", multiplier: 2 },
  { key: "2_5", multiplier: 2.5 },
  { key: "3", multiplier: 3 },
  { key: "4", multiplier: 4 },
  { key: "5", multiplier: 5 },
  { key: "6", multiplier: 6 },
  { key: "7", multiplier: 7 },
  { key: "8", multiplier: 8 },
  { key: "10", multiplier: 10 },
  { key: "12", multiplier: 12 },
] as const

const SEMANTIC_COLOR_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
] as const

const BOX_COMPONENT_SLOTS = new Set([
  "alert",
  "avatar",
  "badge",
  "button",
  "button-group",
  "card",
  "chart",
  "checkbox",
  "combobox-chip",
  "empty",
  "field",
  "field-group",
  "input",
  "item",
  "item-group",
  "native-select",
  "progress",
  "radio-group",
  "radio-group-item",
  "select-trigger",
  "separator",
  "skeleton",
  "slider",
  "switch",
  "table",
  "table-row",
  "table-cell",
  "tabs",
  "tabs-content",
  "tabs-list",
  "tabs-trigger",
  "textarea",
  "toggle-group",
  "toggle-group-item",
])

const CONTROL_TYPES = new Set([
  "badge",
  "button",
  "checkbox",
  "input",
  "native-select",
  "radio-group-item",
  "select-trigger",
  "slider",
  "switch",
  "textarea",
  "toggle-group-item",
])

const TYPOGRAPHY_SIZE_LABELS = [
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
] as const

const FONT_OPTIONS = registryFonts.map((font) => ({
  value: font.name.replace("font-", "") as FontValue,
}))

type Appearance = (typeof DEFAULT_APPEARANCES)[number]
type ViewportName = keyof typeof VIEWPORT_PRESETS
type ViewportProfile = (typeof VIEWPORT_PRESETS)[ViewportName]
type SpacingTokenKey = (typeof SPACING_STEPS)[number]["key"]

type RenderConfig = Pick<
  DesignSystemConfig,
  | "base"
  | "style"
  | "baseColor"
  | "theme"
  | "iconLibrary"
  | "font"
  | "rtl"
  | "menuAccent"
  | "menuColor"
  | "radius"
> & {
  item: string
}

type TrainingTarget = {
  base: BaseName
  style: StyleName
  baseColor: BaseColorName
  theme: ThemeName
  iconLibrary: IconLibraryName
  font: FontValue
  radius: RadiusValue
  menuAccent: MenuAccentValue
  menuColor: MenuColorValue
  rtl: boolean
}

type DatasetSample = {
  sampleId: string
  systemId: string
  preset: string
  config: RenderConfig
  target: TrainingTarget
  url: string
}

type CliOptions = {
  count: number
  baseUrl: string
  item: string
  outputDir: string
  seed: number
  force: boolean
  appearances: Appearance[]
  viewports: ViewportProfile[]
  qualities: number[]
  base?: BaseName
}

type ResolvedColor = {
  cssValue: string
  hex: string
  rgb: [number, number, number]
  alpha: number
  oklch: [number, number, number] | null
}

type ExtractedStyles = {
  backgroundColor: ResolvedColor | null
  color: ResolvedColor | null
  borderColor: ResolvedColor | null
  borderRadius: number | null
  boxShadow: string | null
  fontFamily: string | null
  fontSize: number | null
  fontWeight: number | null
  lineHeight: number | null
  paddingTop: number | null
  paddingRight: number | null
  paddingBottom: number | null
  paddingLeft: number | null
  gap: number | null
  opacity: number | null
}

type ExtractedNode = {
  id: string
  parentId: string | null
  tag: string
  slot: string | null
  type: string
  variant: string | null
  size: string | null
  role: string
  classes: string[]
  text: string | null
  bbox: [number, number, number, number]
  styles: ExtractedStyles
  attributes: Record<string, string>
  children: string[]
}

type ExtractedTextRegion = {
  id: string
  parentId: string | null
  bbox: [number, number, number, number]
  text: string
  fontFamily: string | null
  fontSize: number | null
  fontWeight: number | null
  lineHeight: number | null
  color: ResolvedColor | null
}

type RootMetrics = {
  spacingBasePx: number
  spacingScale: Record<string, number>
  radiusScale: Record<string, number>
  fontFamilies: {
    sans: string | null
    mono: string | null
    serif: string | null
  }
  bodyFontFamily: string | null
}

type ScreenExtraction = {
  capture: {
    width: number
    height: number
  }
  rootMetrics: RootMetrics
  nodes: ExtractedNode[]
  textRegions: ExtractedTextRegion[]
}

type DomNodeRecord = {
  id: string
  tag: string
  role: string
  slot: string | null
  type: string
  variant: string | null
  size: string | null
  text?: string
  classes: string[]
  styles: Record<string, number | string | null>
  children: string[]
}

type DomFile = {
  system_id: string
  screen_id: string
  nodes: DomNodeRecord[]
}

type BoxElementRecord = {
  id: string
  type: string
  variant: string | null
  bbox: [number, number, number, number]
  tokens_used: Record<string, string>
}

type TextRegionRecord = {
  id: string
  bbox: [number, number, number, number]
  text: string
  font_family: string | null
  font_size: number | null
  font_weight: number | null
  line_height: number | null
  color: string | null
  token_refs: Record<string, string>
}

type BoxesFile = {
  system_id: string
  screen_id: string
  coordinate_space: "image_pixels_relative_to_capture_target"
  elements: BoxElementRecord[]
  text_regions: TextRegionRecord[]
}

type ShadowToken = {
  x: number
  y: number
  blur: number
  spread: number
  color: string
}

type TokensFile = {
  system_id: string
  global_tokens: {
    color: Record<
      string,
      {
        hex: string
        rgb: [number, number, number]
        oklch: [number, number, number] | null
        alpha?: number
      }
    >
    spacing: Record<string, number>
    radius: Record<string, number>
    shadow: Record<string, ShadowToken>
    typography: Record<string, number | string>
    size: Record<string, number>
  }
  semantic_tokens: {
    color: Record<
      string,
      {
        light: string
        dark: string
      }
    >
  }
  component_tokens: Record<string, Record<string, Record<string, string | number>>>
}

type ObservationsFile = {
  system_id: string
  screen_id: string
  color_samples: Array<{
    source: string
    region_id: string
    hex: string
    rgb: [number, number, number]
    oklch: [number, number, number] | null
    area: number
  }>
  spacing_observations: Array<{
    between: [string, string]
    axis: "vertical" | "horizontal"
    pixels: number
  }>
  radius_observations: Array<{
    region_id: string
    estimated_px: number
  }>
  size_observations: Array<{
    region_id: string
    kind: "height" | "width"
    estimated_px: number
  }>
}

type TargetFile = {
  system_id: string
  target_config: TrainingTarget
  target_raw_tokens: {
    colors: {
      light: Record<string, string>
      dark: Record<string, string>
    }
    spacing_scale: number[]
    radius_scale: number[]
    control_heights: number[]
    font_family: string | null
  }
  target_semantic_mapping: Record<string, string>
  target_component_bindings: Record<
    string,
    Record<string, string | number>
  >
}

type SampleFilePaths = {
  configPath: string
  themeCssPath: string
  tokensPath: string
  targetPath: string
}

type ManifestCaptureRecord = {
  captureId: string
  quality: number
  imagePath: string
  outputWidth: number
  outputHeight: number
  format: "jpeg"
}

type ManifestScreenRecord = {
  screenId: string
  appearance: Appearance
  viewport: ViewportProfile
  captureWidth: number
  captureHeight: number
  coordinateSpace: "image_pixels_relative_to_capture_target"
  files: {
    domPath: string
    boxesPath: string
    observationsPath: string
  }
  captures: ManifestCaptureRecord[]
}

type ManifestSampleRecord = {
  sampleId: string
  systemId: string
  preset: string
  previewUrl: string
  config: RenderConfig
  targetConfig: TrainingTarget
  files: SampleFilePaths
  screens: ManifestScreenRecord[]
}

type DatasetManifest = {
  schemaVersion: string
  generatedAt: string
  generator: {
    script: string
    baseUrl: string
    item: string
    seed: number
  }
  captureDefaults: {
    appearances: Appearance[]
    qualities: number[]
    viewports: ViewportProfile[]
    base: BaseName | null
  }
  totals: {
    requestedSamples: number
    sampleCount: number
    screenCount: number
    imageCount: number
  }
  provenance: {
    config: string
    themeCss: string
    tokens: string
    dom: string
    boxes: string
    observations: string
    target: string
  }
  samples: ManifestSampleRecord[]
}

type ManifestJsonlRecord = {
  schemaVersion: string
  sampleId: string
  systemId: string
  screenId: string
  captureId: string
  preset: string
  image: string
  configPath: string
  themeCssPath: string
  tokensPath: string
  targetPath: string
  domPath: string
  boxesPath: string
  observationsPath: string
  url: string
  appearance: Appearance
  quality: number
  viewport: ViewportProfile
  captureWidth: number
  captureHeight: number
  outputWidth: number
  outputHeight: number
  target: TrainingTarget & {
    appearance: Appearance
  }
}

type ThemeResolution = Record<
  Appearance,
  Record<
    string,
    {
      tokenKey: string
      color: ResolvedColor
    }
  >
>

function parseArgs(argv: string[]): CliOptions {
  const flags = new Map<string, string | boolean>()

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === "--") {
      continue
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`)
    }

    const [rawKey, inlineValue] = token.split("=", 2)
    const key = rawKey.slice(2)

    if (inlineValue !== undefined) {
      flags.set(key, inlineValue)
      continue
    }

    const nextToken = argv[index + 1]
    if (!nextToken || nextToken.startsWith("--")) {
      flags.set(key, true)
      continue
    }

    flags.set(key, nextToken)
    index++
  }

  if (flags.has("help")) {
    console.log(HELP_TEXT)
    process.exit(0)
  }

  const count = parsePositiveInteger(
    getStringFlag(flags, "count") ?? String(DEFAULT_COUNT),
    "count"
  )
  const seed = parseInteger(
    getStringFlag(flags, "seed") ?? String(Date.now()),
    "seed"
  )
  const baseUrl = getStringFlag(flags, "base-url") ?? DEFAULT_BASE_URL
  const item = getStringFlag(flags, "item") ?? DEFAULT_ITEM
  const force = Boolean(flags.get("force"))

  const baseFlag = getStringFlag(flags, "base")
  const base = baseFlag ? parseBase(baseFlag) : undefined

  const appearances = parseAppearances(
    getStringFlag(flags, "appearances") ?? DEFAULT_APPEARANCES.join(",")
  )
  const viewports = parseViewports(
    getStringFlag(flags, "viewports") ?? DEFAULT_VIEWPORTS.join(",")
  )
  const qualities = parseQualities(
    getStringFlag(flags, "qualities") ?? DEFAULT_QUALITIES.join(",")
  )

  const outputDirFlag = getStringFlag(flags, "output-dir")
  const outputDir = path.resolve(
    process.cwd(),
    outputDirFlag ?? path.join("temp", "theme-training", createTimestamp())
  )

  return {
    count,
    baseUrl,
    item,
    outputDir,
    seed,
    force,
    appearances,
    viewports,
    qualities,
    base,
  }
}

function getStringFlag(
  flags: Map<string, string | boolean>,
  key: string
) {
  const value = flags.get(key)
  if (value === undefined || typeof value === "boolean") {
    return undefined
  }

  return value
}

function parseInteger(value: string, label: string) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected ${label} to be an integer, received "${value}"`)
  }
  return parsed
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = parseInteger(value, label)
  if (parsed <= 0) {
    throw new Error(`Expected ${label} to be greater than 0, received ${parsed}`)
  }
  return parsed
}

function parseBase(value: string) {
  const normalized = value.trim() as BaseName
  const isValid = BASES.some((base) => base.name === normalized)
  if (!isValid) {
    throw new Error(
      `Invalid base "${value}". Expected one of: ${BASES.map((base) => base.name).join(", ")}`
    )
  }
  return normalized
}

function parseAppearances(value: string) {
  const appearances = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (appearances.length === 0) {
    throw new Error("At least one appearance is required")
  }

  const invalid = appearances.filter(
    (appearance): appearance is string =>
      !DEFAULT_APPEARANCES.includes(appearance as Appearance)
  )
  if (invalid.length > 0) {
    throw new Error(`Invalid appearance value(s): ${invalid.join(", ")}`)
  }

  return appearances as Appearance[]
}

function parseViewports(value: string) {
  const names = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (names.length === 0) {
    throw new Error("At least one viewport is required")
  }

  return names.map((name) => {
    if (!(name in VIEWPORT_PRESETS)) {
      throw new Error(
        `Invalid viewport "${name}". Expected one of: ${Object.keys(VIEWPORT_PRESETS).join(", ")}`
      )
    }

    return VIEWPORT_PRESETS[name as ViewportName]
  })
}

function parseQualities(value: string) {
  const qualities = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parsePositiveInteger(entry, "quality"))

  if (qualities.length === 0) {
    throw new Error("At least one quality is required")
  }

  const invalid = qualities.filter((quality) => quality < 1 || quality > 100)
  if (invalid.length > 0) {
    throw new Error(
      `JPEG quality must be between 1 and 100. Invalid value(s): ${invalid.join(", ")}`
    )
  }

  return qualities
}

function createTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickRandom<T>(random: () => number, items: readonly T[]) {
  return items[Math.floor(random() * items.length)]
}

function maybe(random: () => number, probability: number) {
  return random() < probability
}

function getBiasedBaseColors() {
  return BASE_COLORS.filter((color) => color.name !== "gray")
}

function getBiasedFonts(context: RandomizeContext) {
  if (context.style === "lyra") {
    return FONT_OPTIONS.filter((font) => font.value === "jetbrains-mono")
  }

  return FONT_OPTIONS
}

function getBiasedRadii(context: RandomizeContext) {
  if (context.style === "lyra") {
    return RADII.filter((radius) => radius.name === "none")
  }

  return RADII
}

function buildRandomConfig(
  random: () => number,
  item: string,
  baseOverride?: BaseName
): RenderConfig {
  const style = pickRandom(random, STYLES).name as StyleName

  const context: RandomizeContext = { style }
  const baseColor = pickRandom(random, getBiasedBaseColors()).name as BaseColorName
  context.baseColor = baseColor

  const theme = pickRandom(
    random,
    getThemesForBaseColor(baseColor)
  ).name as ThemeName
  context.theme = theme

  const font = pickRandom(random, getBiasedFonts(context)).value as FontValue
  context.font = font

  const radius = pickRandom(random, getBiasedRadii(context)).name as RadiusValue
  const iconLibrary = pickRandom(
    random,
    Object.values(iconLibraries)
  ).name as IconLibraryName
  const menuAccent = pickRandom(random, MENU_ACCENTS).value as MenuAccentValue
  const menuColor = pickRandom(random, MENU_COLORS).value as MenuColorValue
  const base = (baseOverride ?? pickRandom(random, BASES).name) as BaseName

  const parsed = designSystemConfigSchema.parse({
    ...DEFAULT_CONFIG,
    base,
    style,
    baseColor,
    theme,
    iconLibrary,
    font,
    item,
    rtl: maybe(random, RTL_PROBABILITY),
    menuAccent,
    menuColor,
    radius,
  })

  return {
    base: parsed.base,
    style: parsed.style,
    baseColor: parsed.baseColor,
    theme: parsed.theme,
    iconLibrary: parsed.iconLibrary,
    font: parsed.font,
    rtl: parsed.rtl,
    menuAccent: parsed.menuAccent,
    menuColor: parsed.menuColor,
    radius: parsed.radius,
    item: parsed.item ?? item,
  }
}

function buildTrainingTarget(config: RenderConfig): TrainingTarget {
  return {
    base: config.base,
    style: config.style,
    baseColor: config.baseColor,
    theme: config.theme,
    iconLibrary: config.iconLibrary,
    font: config.font,
    radius: config.radius,
    menuAccent: config.menuAccent,
    menuColor: config.menuColor,
    rtl: config.rtl,
  }
}

function getConfigKey(target: TrainingTarget) {
  return [
    target.base,
    target.style,
    target.baseColor,
    target.theme,
    target.iconLibrary,
    target.font,
    target.radius,
    target.menuAccent,
    target.menuColor,
    target.rtl ? "rtl" : "ltr",
  ].join("|")
}

function buildPreset(config: RenderConfig) {
  return encodePreset({
    style: config.style,
    baseColor: config.baseColor,
    theme: config.theme,
    iconLibrary: config.iconLibrary,
    font: config.font,
    radius: config.radius,
    menuAccent: config.menuAccent,
    menuColor: config.menuColor,
  })
}

function buildPreviewUrl(baseUrl: string, sample: DatasetSample) {
  const url = new URL(`/preview/${sample.config.base}/${sample.config.item}`, baseUrl)
  url.searchParams.set("preset", sample.preset)
  if (sample.config.rtl) {
    url.searchParams.set("rtl", "true")
  }
  return url.toString()
}

function createSamples(options: CliOptions) {
  const random = createSeededRandom(options.seed)
  const seen = new Set<string>()
  const samples: DatasetSample[] = []
  const maxAttempts = options.count * 100
  const sampleIdWidth = Math.max(4, String(options.count).length)
  const systemIdWidth = Math.max(6, String(options.count).length)

  let attempts = 0
  while (samples.length < options.count && attempts < maxAttempts) {
    attempts++
    const config = buildRandomConfig(random, options.item, options.base)
    const target = buildTrainingTarget(config)
    const key = getConfigKey(target)

    if (seen.has(key)) {
      continue
    }

    seen.add(key)

    const sampleId = `sample-${String(samples.length + 1).padStart(sampleIdWidth, "0")}`
    const systemId = `system_${String(samples.length + 1).padStart(systemIdWidth, "0")}`
    const preset = buildPreset(config)
    const sample: DatasetSample = {
      sampleId,
      systemId,
      preset,
      config,
      target,
      url: "",
    }
    sample.url = buildPreviewUrl(options.baseUrl, sample)
    samples.push(sample)
  }

  if (samples.length < options.count) {
    console.warn(
      `Requested ${options.count} samples but only generated ${samples.length} unique configs after ${maxAttempts} attempts.`
    )
  }

  return samples
}

async function ensureEmptyOutputDir(outputDir: string, force: boolean) {
  if (force) {
    await fs.rm(outputDir, { recursive: true, force: true })
  }

  await fs.mkdir(outputDir, { recursive: true })

  const entries = await fs.readdir(outputDir)
  if (entries.length > 0) {
    throw new Error(
      `Output directory is not empty: ${outputDir}. Use --force or choose a new path.`
    )
  }
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function preparePageForCapture(page: Page, viewport: ViewportProfile) {
  await page.waitForSelector('[data-slot="capture-target"]', {
    timeout: 60_000,
  })

  await page.evaluate(async (captureScale) => {
    await document.fonts.ready

    const indicator = document.querySelector("[data-tailwind-indicator]")
    indicator?.remove()

    const captureTarget = document.querySelector(
      '[data-slot="capture-target"]'
    ) as HTMLElement | null
    const captureViewport = captureTarget?.parentElement

    // The preview page is optimized for interactive browsing, not full-frame
    // screenshots. Disable clipping/lazy rendering so off-screen columns paint.
    if (captureViewport instanceof HTMLElement) {
      captureViewport.style.overflow = "visible"
      captureViewport.style.contain = "none"
      captureViewport.style.width = "max-content"
      captureViewport.style.maxWidth = "none"
    }

    if (captureTarget) {
      captureTarget.style.contain = "none"
      captureTarget.style.maxWidth = "none"
      captureTarget.style.transformOrigin = "top left"
      captureTarget.style.zoom = String(captureScale)

      Array.from(captureTarget.children).forEach((child) => {
        if (!(child instanceof HTMLElement)) {
          return
        }

        child.style.contentVisibility = "visible"
        child.style.containIntrinsicSize = "auto"
      })
    }

    let style = document.getElementById(
      "__theme-training-capture"
    ) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement("style")
      style.id = "__theme-training-capture"
      document.head.appendChild(style)
    }

    style.textContent = `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `

    window.scrollTo(0, 0)
  }, viewport.captureScale)

  await wait(WAIT_AFTER_RELOAD_MS)
}

async function setAppearance(page: Page, appearance: Appearance) {
  await page.evaluate((nextAppearance) => {
    localStorage.setItem("theme", nextAppearance)
  }, appearance)

  await page.reload({ waitUntil: "networkidle2" })
}

async function setAppearanceAndPrepare(
  page: Page,
  appearance: Appearance,
  viewport: ViewportProfile
) {
  await setAppearance(page, appearance)
  await preparePageForCapture(page, viewport)
}

function toManifestPath(filePath: string, outputDir: string) {
  return path.relative(outputDir, filePath).split(path.sep).join("/")
}

function toTokenKey(value: string) {
  return value.replace(/-/g, "_")
}

function semanticColorRef(name: string) {
  return `semantic.color.${toTokenKey(name)}`
}

function roundNumber(value: number, digits = 3) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Number(value.toFixed(digits))
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? ""
}

function parsePx(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function primaryFontFamily(value: string | null) {
  if (!value) {
    return null
  }

  const first = value.split(",")[0]?.trim()
  return first?.replace(/^["']|["']$/g, "") ?? null
}

function buildThemeCss(config: RenderConfig) {
  const registryTheme = buildRegistryTheme({
    ...DEFAULT_CONFIG,
    base: config.base,
    style: config.style,
    baseColor: config.baseColor,
    theme: config.theme,
    iconLibrary: config.iconLibrary,
    font: config.font,
    item: config.item,
    rtl: config.rtl,
    menuAccent: config.menuAccent,
    menuColor: config.menuColor,
    radius: config.radius,
  })

  const {
    light: lightVars,
    dark: darkVars,
    theme: themeVars,
  } = registryTheme.cssVars

  let cssText = ":root {\n"

  if (themeVars) {
    Object.entries(themeVars).forEach(([key, value]) => {
      if (value) {
        cssText += `  --${key}: ${value};\n`
      }
    })
  }

  if (lightVars) {
    Object.entries(lightVars).forEach(([key, value]) => {
      if (value) {
        cssText += `  --${key}: ${value};\n`
      }
    })
  }

  cssText += "}\n\n.dark {\n"

  if (darkVars) {
    Object.entries(darkVars).forEach(([key, value]) => {
      if (value) {
        cssText += `  --${key}: ${value};\n`
      }
    })
  }

  cssText += "}\n"

  return cssText
}

function inferButtonVariant(node: ExtractedNode) {
  if (node.variant) {
    return node.variant
  }

  const variantClass = node.classes.find((className) =>
    className.startsWith("cn-button-variant-")
  )

  return variantClass?.replace("cn-button-variant-", "") ?? "default"
}

function inferButtonSize(node: ExtractedNode) {
  if (node.size) {
    return node.size
  }

  const sizeClass = node.classes.find((className) =>
    className.startsWith("cn-button-size-")
  )

  return sizeClass?.replace("cn-button-size-", "") ?? "default"
}

function inferCardSize(node: ExtractedNode) {
  return node.size ?? "default"
}

function getNodeType(node: ExtractedNode) {
  return node.slot ? toTokenKey(node.slot) : toTokenKey(node.type)
}

function isBoxElement(node: ExtractedNode) {
  if (node.id === "node_0001") {
    return false
  }

  if (node.slot && BOX_COMPONENT_SLOTS.has(node.slot)) {
    return true
  }

  return ["button", "input", "select", "textarea", "table"].includes(node.tag)
}

function collectVisibleNodesById(nodes: ExtractedNode[]) {
  return new Map(nodes.map((node) => [node.id, node]))
}

function extractNumericSet(values: Array<number | null | undefined>) {
  return Array.from(
    new Set(
      values
        .filter((value): value is number => typeof value === "number")
        .map((value) => roundNumber(value, 3))
    )
  ).sort((left, right) => left - right)
}

function buildTypographyTokens(screen: ScreenExtraction) {
  const textRegions = screen.textRegions.filter(
    (region) => region.fontSize && region.lineHeight
  )
  const fontSizes = extractNumericSet(textRegions.map((region) => region.fontSize))
  const fontWeights = extractNumericSet(
    textRegions.map((region) => region.fontWeight)
  )

  const typography: Record<string, number | string> = {}
  const fontFamilySans =
    primaryFontFamily(screen.rootMetrics.fontFamilies.sans) ??
    primaryFontFamily(screen.rootMetrics.bodyFontFamily)

  if (fontFamilySans) {
    typography.font_family_sans = fontFamilySans
  }

  const fontFamilyMono = primaryFontFamily(screen.rootMetrics.fontFamilies.mono)
  if (fontFamilyMono) {
    typography.font_family_mono = fontFamilyMono
  }

  const fontFamilySerif = primaryFontFamily(screen.rootMetrics.fontFamilies.serif)
  if (fontFamilySerif) {
    typography.font_family_serif = fontFamilySerif
  }

  const labelCount = Math.min(fontSizes.length, TYPOGRAPHY_SIZE_LABELS.length)
  for (let index = 0; index < labelCount; index++) {
    const label = TYPOGRAPHY_SIZE_LABELS[index]
    const fontSize = fontSizes[index]
    const matchingRegion = textRegions.find(
      (region) => roundNumber(region.fontSize ?? 0, 3) === fontSize
    )
    typography[`font_size_${label}`] = fontSize
    typography[`line_height_${label}`] = roundNumber(
      matchingRegion?.lineHeight ?? fontSize
    )
  }

  const weightMap = new Map<number, string>([
    [400, "regular"],
    [500, "medium"],
    [600, "semibold"],
    [700, "bold"],
  ])

  fontWeights.forEach((weight) => {
    const label = weightMap.get(weight)
    if (label) {
      typography[`font_weight_${label}`] = weight
    }
  })

  return typography
}

function buildSizeTokens(screen: ScreenExtraction) {
  const buttons = screen.nodes.filter((node) => getNodeType(node) === "button")
  const sizeByKey = new Map<string, number[]>()

  buttons.forEach((button) => {
    const sizeKey = inferButtonSize(button)
    const height = button.styles.borderRadius !== null ? button.bbox[3] - button.bbox[1] : null
    if (!height) {
      return
    }

    const entries = sizeByKey.get(sizeKey) ?? []
    entries.push(roundNumber(height, 3))
    sizeByKey.set(sizeKey, entries)
  })

  const resolveAverage = (values: number[]) =>
    roundNumber(values.reduce((total, value) => total + value, 0) / values.length)

  const tokens: Record<string, number> = {}
  const mapping: Array<[string, string]> = [
    ["xs", "control_xs"],
    ["sm", "control_sm"],
    ["default", "control_md"],
    ["lg", "control_lg"],
  ]

  mapping.forEach(([sourceKey, tokenKey]) => {
    const values = sizeByKey.get(sourceKey)
    if (values && values.length > 0) {
      tokens[tokenKey] = resolveAverage(values)
    }
  })

  if (Object.keys(tokens).length === 0) {
    const uniqueHeights = extractNumericSet(
      buttons.map((button) => button.bbox[3] - button.bbox[1])
    )
    if (uniqueHeights[0] !== undefined) {
      tokens.control_xs = uniqueHeights[0]
    }
    if (uniqueHeights[1] !== undefined) {
      tokens.control_sm = uniqueHeights[1]
    }
    if (uniqueHeights[2] !== undefined) {
      tokens.control_md = uniqueHeights[2]
    }
    if (uniqueHeights[3] !== undefined) {
      tokens.control_lg = uniqueHeights[3]
    }
  }

  return tokens
}

function parseBoxShadow(value: string | null): ShadowToken | null {
  if (!value || value === "none") {
    return null
  }

  const match = value.match(
    /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|oklch\([^)]*\)|[a-z]+)\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?/
  )

  if (!match) {
    return null
  }

  return {
    color: match[1],
    x: roundNumber(Number.parseFloat(match[2])),
    y: roundNumber(Number.parseFloat(match[3])),
    blur: roundNumber(Number.parseFloat(match[4])),
    spread: roundNumber(Number.parseFloat(match[5] ?? "0")),
  }
}

function buildShadowTokens(screen: ScreenExtraction) {
  const shadows: Record<string, ShadowToken> = {}

  const firstCardShadow = screen.nodes.find(
    (node) => getNodeType(node) === "card" && node.styles.boxShadow
  )
  const firstButtonShadow = screen.nodes.find(
    (node) => getNodeType(node) === "button" && node.styles.boxShadow
  )

  const cardShadow = parseBoxShadow(firstCardShadow?.styles.boxShadow ?? null)
  if (cardShadow) {
    shadows.surface = cardShadow
  }

  const buttonShadow = parseBoxShadow(firstButtonShadow?.styles.boxShadow ?? null)
  if (buttonShadow) {
    shadows.control = buttonShadow
  }

  return shadows
}

function findClosestTokenRef(
  value: number | null | undefined,
  tokens: Record<string, number>,
  prefix: string
) {
  if (value === null || value === undefined) {
    return null
  }

  const entries = Object.entries(tokens)
  if (entries.length === 0) {
    return null
  }

  const closest = entries.reduce((best, current) => {
    const bestDistance = Math.abs(best[1] - value)
    const currentDistance = Math.abs(current[1] - value)
    return currentDistance < bestDistance ? current : best
  })

  return `${prefix}.${closest[0]}`
}

function buildThemeResolution(
  registryTheme: ReturnType<typeof buildRegistryTheme>,
  resolvedColors: ThemeResolution
) {
  const resolution: ThemeResolution = {
    light: {},
    dark: {},
  }

  ;(["light", "dark"] as const).forEach((appearance) => {
    const sourceVars = registryTheme.cssVars[appearance] ?? {}
    Object.entries(sourceVars).forEach(([name]) => {
      const key = toTokenKey(`${name}_${appearance}`)
      const existing = resolvedColors[appearance][name]
      if (existing) {
        resolution[appearance][name] = {
          tokenKey: key,
          color: existing.color,
        }
      }
    })
  })

  return resolution
}

function buildTokensFile(
  sample: DatasetSample,
  screen: ScreenExtraction,
  themeResolution: ThemeResolution
) {
  const globalColors: TokensFile["global_tokens"]["color"] = {}

  ;(["light", "dark"] as const).forEach((appearance) => {
    Object.entries(themeResolution[appearance]).forEach(([name, entry]) => {
      globalColors[entry.tokenKey] = {
        hex: entry.color.hex,
        rgb: entry.color.rgb,
        oklch: entry.color.oklch,
        ...(entry.color.alpha < 1 ? { alpha: entry.color.alpha } : {}),
      }
    })
  })

  const semanticTokens: TokensFile["semantic_tokens"]["color"] = {}
  SEMANTIC_COLOR_NAMES.forEach((name) => {
    const lightEntry = themeResolution.light[name]
    const darkEntry = themeResolution.dark[name]
    if (!lightEntry || !darkEntry) {
      return
    }

    semanticTokens[toTokenKey(name)] = {
      light: lightEntry.tokenKey,
      dark: darkEntry.tokenKey,
    }
  })

  const spacingTokens = screen.rootMetrics.spacingScale
  const radiusTokens = {
    none: 0,
    ...screen.rootMetrics.radiusScale,
  }
  const typographyTokens = buildTypographyTokens(screen)
  const sizeTokens = buildSizeTokens(screen)
  const shadowTokens = buildShadowTokens(screen)

  const nodesById = collectVisibleNodesById(screen.nodes)
  const cards = screen.nodes.filter((node) => getNodeType(node) === "card")
  const buttons = screen.nodes.filter((node) => getNodeType(node) === "button")
  const componentTokens: TokensFile["component_tokens"] = {
    button: {},
    card: {},
  }

  const buttonVariants = new Map<string, ExtractedNode[]>()
  buttons.forEach((button) => {
    const variant = inferButtonVariant(button)
    const entries = buttonVariants.get(variant) ?? []
    entries.push(button)
    buttonVariants.set(variant, entries)
  })

  buttonVariants.forEach((variantNodes, variant) => {
    const dominantNode = variantNodes[0]
    const dominantSize = inferButtonSize(dominantNode)
    const sizeRefMap: Record<string, string> = {
      xs: "global.size.control_xs",
      sm: "global.size.control_sm",
      default: "global.size.control_md",
      lg: "global.size.control_lg",
    }

    const buttonTokenRecord: Record<string, string | number> = {}

    if (variant === "default") {
      buttonTokenRecord.background = semanticColorRef("primary")
      buttonTokenRecord.foreground = semanticColorRef("primary-foreground")
    } else if (variant === "outline") {
      buttonTokenRecord.background = semanticColorRef("background")
      buttonTokenRecord.foreground = semanticColorRef("foreground")
      buttonTokenRecord.border = semanticColorRef("border")
    } else if (variant === "secondary") {
      buttonTokenRecord.background = semanticColorRef("secondary")
      buttonTokenRecord.foreground = semanticColorRef("secondary-foreground")
    } else if (variant === "ghost") {
      buttonTokenRecord.foreground = semanticColorRef("foreground")
    } else if (variant === "link") {
      buttonTokenRecord.foreground = semanticColorRef("primary")
    } else if (variant === "destructive") {
      buttonTokenRecord.background = semanticColorRef("destructive")
      buttonTokenRecord.foreground = semanticColorRef("destructive")
    }

    const sizeRef = sizeRefMap[dominantSize]
    if (sizeRef) {
      buttonTokenRecord.height = sizeRef
    }

    const radiusRef = findClosestTokenRef(
      dominantNode.styles.borderRadius,
      radiusTokens,
      "global.radius"
    )
    if (radiusRef) {
      buttonTokenRecord.radius = radiusRef
    }

    const paddingRef = findClosestTokenRef(
      dominantNode.styles.paddingLeft,
      spacingTokens,
      "global.spacing"
    )
    if (paddingRef) {
      buttonTokenRecord.padding_x = paddingRef
    }

    const fontWeightRef = dominantNode.styles.fontWeight
      ? findClosestTokenRef(
          dominantNode.styles.fontWeight,
          Object.fromEntries(
            Object.entries(typographyTokens)
              .filter(([key, value]) => key.startsWith("font_weight_"))
              .map(([key, value]) => [key, Number(value)])
          ),
          "global.typography"
        )
      : null

    if (fontWeightRef) {
      buttonTokenRecord.font_weight = fontWeightRef
    }

    componentTokens.button[variant] = buttonTokenRecord
  })

  const firstCard = cards[0]
  if (firstCard) {
    const cardTokenRecord: Record<string, string | number> = {
      background: semanticColorRef("card"),
      foreground: semanticColorRef("card-foreground"),
    }

    const radiusRef = findClosestTokenRef(
      firstCard.styles.borderRadius,
      radiusTokens,
      "global.radius"
    )
    if (radiusRef) {
      cardTokenRecord.radius = radiusRef
    }

    const shadowKey = shadowTokens.surface ? "global.shadow.surface" : null
    if (shadowKey) {
      cardTokenRecord.shadow = shadowKey
    }

    const childSlots = firstCard.children
      .map((childId) => nodesById.get(childId))
      .filter((child): child is ExtractedNode => Boolean(child))
    const contentNode = childSlots.find((child) => child.slot === "card-content")
    const headerNode = childSlots.find((child) => child.slot === "card-header")
    const paddingSource = contentNode ?? headerNode ?? firstCard
    const paddingRef = findClosestTokenRef(
      paddingSource.styles.paddingLeft,
      spacingTokens,
      "global.spacing"
    )
    if (paddingRef) {
      cardTokenRecord.padding = paddingRef
    }

    componentTokens.card[inferCardSize(firstCard)] = cardTokenRecord
  }

  return {
    system_id: sample.systemId,
    global_tokens: {
      color: globalColors,
      spacing: spacingTokens,
      radius: radiusTokens,
      shadow: shadowTokens,
      typography: typographyTokens,
      size: sizeTokens,
    },
    semantic_tokens: {
      color: semanticTokens,
    },
    component_tokens: componentTokens,
  } satisfies TokensFile
}

function buildTargetFile(sample: DatasetSample, tokens: TokensFile) {
  const lightColors: Record<string, string> = {}
  const darkColors: Record<string, string> = {}

  Object.entries(tokens.semantic_tokens.color).forEach(([name, refs]) => {
    lightColors[name] = tokens.global_tokens.color[refs.light]?.hex ?? "#000000"
    darkColors[name] = tokens.global_tokens.color[refs.dark]?.hex ?? "#000000"
  })

  const spacingScale = extractNumericSet(Object.values(tokens.global_tokens.spacing))
  const radiusScale = extractNumericSet(Object.values(tokens.global_tokens.radius))
  const controlHeights = extractNumericSet(Object.values(tokens.global_tokens.size))

  const targetComponentBindings: Record<string, Record<string, string | number>> = {}

  Object.entries(tokens.component_tokens.button).forEach(([variant, values]) => {
    const binding: Record<string, string | number> = {}

    Object.entries(values).forEach(([key, value]) => {
      if (key === "background" || key === "foreground" || key === "border") {
        binding[key] = String(value).replace("semantic.color.", "")
      } else if (key === "height") {
        const sizeKey = String(value).replace("global.size.", "")
        binding.height = tokens.global_tokens.size[sizeKey] ?? String(value)
      } else if (key === "radius") {
        const radiusKey = String(value).replace("global.radius.", "")
        binding.radius = tokens.global_tokens.radius[radiusKey] ?? String(value)
      } else {
        binding[key] = value
      }
    })

    targetComponentBindings[`button.${variant}`] = binding
  })

  Object.entries(tokens.component_tokens.card).forEach(([variant, values]) => {
    const binding: Record<string, string | number> = {}

    Object.entries(values).forEach(([key, value]) => {
      if (key === "background" || key === "foreground") {
        binding[key] = String(value).replace("semantic.color.", "")
      } else if (key === "radius") {
        const radiusKey = String(value).replace("global.radius.", "")
        binding.radius = tokens.global_tokens.radius[radiusKey] ?? String(value)
      } else if (key === "padding") {
        const spacingKey = String(value).replace("global.spacing.", "")
        binding.padding = tokens.global_tokens.spacing[spacingKey] ?? String(value)
      } else if (key === "shadow") {
        binding.shadow = String(value).replace("global.shadow.", "")
      } else {
        binding[key] = value
      }
    })

    targetComponentBindings[`card.${variant}`] = binding
  })

  return {
    system_id: sample.systemId,
    target_config: sample.target,
    target_raw_tokens: {
      colors: {
        light: lightColors,
        dark: darkColors,
      },
      spacing_scale: spacingScale,
      radius_scale: radiusScale,
      control_heights: controlHeights,
      font_family:
        typeof tokens.global_tokens.typography.font_family_sans === "string"
          ? tokens.global_tokens.typography.font_family_sans
          : null,
    },
    target_semantic_mapping: Object.fromEntries(
      Object.keys(tokens.semantic_tokens.color).map((name) => [name, name])
    ),
    target_component_bindings: targetComponentBindings,
  } satisfies TargetFile
}

function buildSemanticHexIndex(
  tokens: TokensFile
): Record<Appearance, Map<string, string>> {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()

  Object.entries(tokens.semantic_tokens.color).forEach(([name, refs]) => {
    const lightHex = tokens.global_tokens.color[refs.light]?.hex
    const darkHex = tokens.global_tokens.color[refs.dark]?.hex
    if (lightHex) {
      light.set(lightHex, semanticColorRef(name))
    }
    if (darkHex) {
      dark.set(darkHex, semanticColorRef(name))
    }
  })

  return { light, dark }
}

function buildDomFile(
  sample: DatasetSample,
  screenId: string,
  screen: ScreenExtraction
) {
  return {
    system_id: sample.systemId,
    screen_id: screenId,
    nodes: screen.nodes.map((node) => ({
      id: node.id,
      tag: node.tag,
      role: node.role,
      slot: node.slot,
      type: node.type,
      variant: node.variant,
      size: node.size,
      ...(node.text ? { text: node.text } : {}),
      classes: node.classes,
      styles: {
        backgroundColor: node.styles.backgroundColor?.hex ?? null,
        color: node.styles.color?.hex ?? null,
        borderColor: node.styles.borderColor?.hex ?? null,
        borderRadius: node.styles.borderRadius,
        boxShadow: node.styles.boxShadow,
        fontFamily: node.styles.fontFamily,
        fontSize: node.styles.fontSize,
        fontWeight: node.styles.fontWeight,
        lineHeight: node.styles.lineHeight,
      },
      children: node.children,
    })),
  } satisfies DomFile
}

function inferElementTokenUsage(
  node: ExtractedNode,
  tokens: TokensFile
) {
  const usage: Record<string, string> = {}

  if (getNodeType(node) === "button") {
    const variant = inferButtonVariant(node)
    const componentTokens = tokens.component_tokens.button[variant] ?? {}

    Object.entries(componentTokens).forEach(([key, value]) => {
      if (typeof value === "string") {
        usage[key] = value
      }
    })

    const sizeRefMap: Record<string, string> = {
      xs: "global.size.control_xs",
      sm: "global.size.control_sm",
      default: "global.size.control_md",
      lg: "global.size.control_lg",
    }

    const size = inferButtonSize(node)
    const sizeRef = sizeRefMap[size]
    if (sizeRef) {
      usage.height = sizeRef
    }

    return usage
  }

  if (getNodeType(node) === "card") {
    const size = inferCardSize(node)
    const componentTokens = tokens.component_tokens.card[size] ?? {}
    Object.entries(componentTokens).forEach(([key, value]) => {
      if (typeof value === "string") {
        usage[key] = value
      }
    })
    return usage
  }

  if (["input", "textarea", "select_trigger", "native_select"].includes(getNodeType(node))) {
    usage.background = semanticColorRef("background")
    usage.foreground = semanticColorRef("foreground")
    usage.border = semanticColorRef("border")

    const radiusRef = findClosestTokenRef(
      node.styles.borderRadius,
      tokens.global_tokens.radius,
      "global.radius"
    )
    if (radiusRef) {
      usage.radius = radiusRef
    }

    const heightRef = findClosestTokenRef(
      node.bbox[3] - node.bbox[1],
      tokens.global_tokens.size,
      "global.size"
    )
    if (heightRef) {
      usage.height = heightRef
    }
  }

  return usage
}

function buildBoxesFile(
  sample: DatasetSample,
  screenId: string,
  appearance: Appearance,
  screen: ScreenExtraction,
  tokens: TokensFile
) {
  const semanticHexIndex = buildSemanticHexIndex(tokens)
  const nodes = screen.nodes.filter(isBoxElement)

  const elements = nodes.map((node) => ({
    id: node.id,
    type: getNodeType(node),
    variant:
      getNodeType(node) === "button"
        ? inferButtonVariant(node)
        : getNodeType(node) === "card"
          ? inferCardSize(node)
          : node.variant,
    bbox: node.bbox,
    tokens_used: inferElementTokenUsage(node, tokens),
  }))

  const textRegions = screen.textRegions.map((region) => {
    const tokenRefs: Record<string, string> = {}

    const colorRef = region.color
      ? semanticHexIndex[appearance].get(region.color.hex)
      : null
    if (colorRef) {
      tokenRefs.color = colorRef
    }

    const fontSizeRef = findClosestTokenRef(
      region.fontSize,
      Object.fromEntries(
        Object.entries(tokens.global_tokens.typography)
          .filter(([key, value]) => key.startsWith("font_size_"))
          .map(([key, value]) => [key, Number(value)])
      ),
      "global.typography"
    )
    if (fontSizeRef) {
      tokenRefs.font_size = fontSizeRef
    }

    const fontWeightRef = findClosestTokenRef(
      region.fontWeight,
      Object.fromEntries(
        Object.entries(tokens.global_tokens.typography)
          .filter(([key, value]) => key.startsWith("font_weight_"))
          .map(([key, value]) => [key, Number(value)])
      ),
      "global.typography"
    )
    if (fontWeightRef) {
      tokenRefs.font_weight = fontWeightRef
    }

    return {
      id: region.id,
      bbox: region.bbox,
      text: region.text,
      font_family: primaryFontFamily(region.fontFamily),
      font_size: region.fontSize,
      font_weight: region.fontWeight,
      line_height: region.lineHeight,
      color: region.color?.hex ?? null,
      token_refs: tokenRefs,
    }
  })

  return {
    system_id: sample.systemId,
    screen_id: screenId,
    coordinate_space: "image_pixels_relative_to_capture_target",
    elements,
    text_regions: textRegions,
  } satisfies BoxesFile
}

function buildSpacingObservations(nodes: ExtractedNode[]) {
  const observations: ObservationsFile["spacing_observations"] = []
  const seen = new Set<string>()

  const nodeMap = new Map(nodes.map((node) => [node.id, node]))

  nodes.forEach((node) => {
    const siblings = node.parentId
      ? nodes.filter((candidate) => candidate.parentId === node.parentId)
      : []
    const sortedSiblings = siblings.sort((left, right) => {
      if (left.bbox[1] !== right.bbox[1]) {
        return left.bbox[1] - right.bbox[1]
      }
      return left.bbox[0] - right.bbox[0]
    })

    for (let index = 0; index < sortedSiblings.length - 1; index++) {
      const current = sortedSiblings[index]
      const next = sortedSiblings[index + 1]
      if (!nodeMap.has(current.id) || !nodeMap.has(next.id)) {
        continue
      }

      const verticalGap = roundNumber(next.bbox[1] - current.bbox[3])
      const horizontalGap = roundNumber(next.bbox[0] - current.bbox[2])
      const xOverlap =
        Math.min(current.bbox[2], next.bbox[2]) -
        Math.max(current.bbox[0], next.bbox[0])
      const yOverlap =
        Math.min(current.bbox[3], next.bbox[3]) -
        Math.max(current.bbox[1], next.bbox[1])

      if (verticalGap >= 0 && xOverlap > 8) {
        const key = `${current.id}:${next.id}:vertical`
        if (!seen.has(key)) {
          seen.add(key)
          observations.push({
            between: [current.id, next.id],
            axis: "vertical",
            pixels: verticalGap,
          })
        }
      } else if (horizontalGap >= 0 && yOverlap > 8) {
        const key = `${current.id}:${next.id}:horizontal`
        if (!seen.has(key)) {
          seen.add(key)
          observations.push({
            between: [current.id, next.id],
            axis: "horizontal",
            pixels: horizontalGap,
          })
        }
      }
    }
  })

  return observations.slice(0, 200)
}

function buildObservationsFile(
  sample: DatasetSample,
  screenId: string,
  appearance: Appearance,
  screen: ScreenExtraction,
  tokens: TokensFile
) {
  const semanticHexIndex = buildSemanticHexIndex(tokens)
  const componentNodes = screen.nodes.filter(isBoxElement)

  const colorSamples: ObservationsFile["color_samples"] = []
  componentNodes.forEach((node) => {
    const background = node.styles.backgroundColor
    if (!background || background.alpha === 0) {
      return
    }

    const colorRef = semanticHexIndex[appearance].get(background.hex)
    const oklch = colorRef
      ? tokens.global_tokens.color[
          tokens.semantic_tokens.color[colorRef.replace("semantic.color.", "")]?.[
            appearance
          ] ?? ""
        ]?.oklch ?? background.oklch
      : background.oklch

    colorSamples.push({
      source: "computed_style_background",
      region_id: node.id,
      hex: background.hex,
      rgb: background.rgb,
      oklch,
      area: roundNumber((node.bbox[2] - node.bbox[0]) * (node.bbox[3] - node.bbox[1])),
    })
  })

  const radiusObservations = componentNodes
    .filter(
      (node) =>
        node.styles.borderRadius !== null && node.styles.borderRadius > 0
    )
    .map((node) => ({
      region_id: node.id,
      estimated_px: roundNumber(node.styles.borderRadius ?? 0),
    }))

  const sizeObservations = componentNodes
    .filter((node) => CONTROL_TYPES.has(getNodeType(node)))
    .flatMap((node) => {
      const width = roundNumber(node.bbox[2] - node.bbox[0])
      const height = roundNumber(node.bbox[3] - node.bbox[1])
      return [
        {
          region_id: node.id,
          kind: "width" as const,
          estimated_px: width,
        },
        {
          region_id: node.id,
          kind: "height" as const,
          estimated_px: height,
        },
      ]
    })

  return {
    system_id: sample.systemId,
    screen_id: screenId,
    color_samples: colorSamples,
    spacing_observations: buildSpacingObservations(componentNodes),
    radius_observations: radiusObservations,
    size_observations: sizeObservations,
  } satisfies ObservationsFile
}

const RESOLVE_THEME_COLORS_SOURCE = String.raw`
const parseOklch = (colorText) => {
  const match = colorText.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i)
  if (!match) {
    return null
  }

  return [
    Number.parseFloat(match[1]),
    Number.parseFloat(match[2]),
    Number.parseFloat(match[3]),
  ]
}

const rgbaFromColor = (colorText) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('Could not create a canvas context for color parsing.')
  }

  context.clearRect(0, 0, 1, 1)
  context.fillStyle = '#000000'
  context.fillStyle = colorText
  context.fillRect(0, 0, 1, 1)
  const data = context.getImageData(0, 0, 1, 1).data
  return [data[0], data[1], data[2], data[3]]
}

const toHex = (red, green, blue, alpha) => {
  const toPart = (value) => value.toString(16).padStart(2, '0')
  if (alpha < 255) {
    return '#' + toPart(red) + toPart(green) + toPart(blue) + toPart(alpha)
  }
  return '#' + toPart(red) + toPart(green) + toPart(blue)
}

const result = { light: {}, dark: {} }
;['light', 'dark'].forEach((appearance) => {
  const sourceVars = args[appearance] || {}
  Object.entries(sourceVars).forEach(([name, cssValue]) => {
    if (!cssValue) {
      return
    }

    const [red, green, blue, alphaByte] = rgbaFromColor(cssValue)
    const alpha = Number((alphaByte / 255).toFixed(4))
    result[appearance][name] = {
      tokenKey: (name + '_' + appearance).replace(/-/g, '_'),
      color: {
        cssValue,
        hex: toHex(red, green, blue, alphaByte),
        rgb: [red, green, blue],
        alpha,
        oklch: parseOklch(cssValue),
      },
    }
  })
})

return result
`

const EXTRACT_SCREEN_ARTIFACTS_SOURCE = String.raw`
const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Number(value.toFixed(digits))
}

const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim()

const parseNumber = (value) => {
  if (!value) {
    return null
  }
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? round(parsed) : null
}

const parseLineHeight = (value, fontSize) => {
  if (value === 'normal') {
    const parsedFontSize = parseNumber(fontSize)
    return parsedFontSize ? round(parsedFontSize * 1.2) : null
  }

  return parseNumber(value)
}

const parseOklch = (colorText) => {
  const match = colorText.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i)
  if (!match) {
    return null
  }

  return [
    Number.parseFloat(match[1]),
    Number.parseFloat(match[2]),
    Number.parseFloat(match[3]),
  ]
}

const rgbaFromColor = (colorText) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('Could not create a canvas context for color parsing.')
  }

  context.clearRect(0, 0, 1, 1)
  context.fillStyle = '#000000'
  context.fillStyle = colorText
  context.fillRect(0, 0, 1, 1)
  const data = context.getImageData(0, 0, 1, 1).data
  return [data[0], data[1], data[2], data[3]]
}

const toHex = (red, green, blue, alpha) => {
  const toPart = (value) => value.toString(16).padStart(2, '0')
  if (alpha < 255) {
    return '#' + toPart(red) + toPart(green) + toPart(blue) + toPart(alpha)
  }
  return '#' + toPart(red) + toPart(green) + toPart(blue)
}

const resolveColor = (colorText) => {
  if (!colorText) {
    return null
  }

  const [red, green, blue, alphaByte] = rgbaFromColor(colorText)
  const alpha = round(alphaByte / 255, 4)
  if (alpha === 0) {
    return null
  }

  return {
    cssValue: colorText,
    hex: toHex(red, green, blue, alphaByte),
    rgb: [red, green, blue],
    alpha,
    oklch: parseOklch(colorText),
  }
}

const measurePx = (property, value) => {
  const element = document.createElement('div')
  element.style.position = 'absolute'
  element.style.visibility = 'hidden'
  element.style.pointerEvents = 'none'
  element.style[property] = value
  document.body.appendChild(element)
  const rect = element.getBoundingClientRect()
  element.remove()
  return round(property === 'width' ? rect.width : rect.height)
}

const measureRadius = (value) => {
  const element = document.createElement('div')
  element.style.position = 'absolute'
  element.style.visibility = 'hidden'
  element.style.pointerEvents = 'none'
  element.style.borderRadius = value
  document.body.appendChild(element)
  const radius = getComputedStyle(element).borderTopLeftRadius
  element.remove()
  return parseNumber(radius) || 0
}

const inferButtonVariant = (element) => {
  const dataVariant = element.getAttribute('data-variant')
  if (dataVariant) {
    return dataVariant
  }

  const className = Array.from(element.classList).find((entry) =>
    entry.startsWith('cn-button-variant-')
  )
  return className ? className.replace('cn-button-variant-', '') : 'default'
}

const inferButtonSize = (element) => {
  const dataSize = element.getAttribute('data-size')
  if (dataSize) {
    return dataSize
  }

  const className = Array.from(element.classList).find((entry) =>
    entry.startsWith('cn-button-size-')
  )
  return className ? className.replace('cn-button-size-', '') : 'default'
}

const inferType = (element) => {
  const slot = element.getAttribute('data-slot')
  if (slot) {
    return slot.replace(/-/g, '_')
  }
  return element.tagName.toLowerCase()
}

const inferRole = (element) => {
  const slot = element.getAttribute('data-slot')
  const explicitRole = element.getAttribute('role')

  if (slot === 'button' || element.tagName.toLowerCase() === 'button') {
    return 'button.' + inferButtonVariant(element)
  }

  if (slot === 'card') {
    return 'card.' + (element.getAttribute('data-size') || 'default')
  }

  if (explicitRole) {
    return explicitRole
  }

  if (slot) {
    return slot.replace(/-/g, '.')
  }

  return element.tagName.toLowerCase()
}

const isVisible = (element) => {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) > 0 &&
    rect.width > 0 &&
    rect.height > 0
  )
}

const textForElement = (element) => {
  if (
    element.children.length === 0 ||
    ['button', 'label', 'a'].includes(element.tagName.toLowerCase())
  ) {
    const text = normalize(element.textContent)
    return text.length > 0 ? text : null
  }

  return null
}

const toBbox = (rect, targetRect) => [
  round(rect.left - targetRect.left),
  round(rect.top - targetRect.top),
  round(rect.right - targetRect.left),
  round(rect.bottom - targetRect.top),
]

const captureTarget = document.querySelector('[data-slot="capture-target"]')
if (!captureTarget) {
  throw new Error('Capture target not found.')
}

const targetRect = captureTarget.getBoundingClientRect()
const includedElements = [
  captureTarget,
  ...Array.from(captureTarget.querySelectorAll('*')).filter((element) => {
    if (!isVisible(element)) {
      return false
    }

    return (
      element.hasAttribute('data-slot') ||
      ['button', 'input', 'textarea', 'select', 'table'].includes(
        element.tagName.toLowerCase()
      )
    )
  }),
]

const ids = new Map()
includedElements.forEach((element, index) => {
  ids.set(element, 'node_' + String(index + 1).padStart(4, '0'))
})

const nodes = includedElements.map((element) => {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  let parentId = null
  let currentParent = element.parentElement

  while (currentParent) {
    const match = ids.get(currentParent)
    if (match) {
      parentId = match
      break
    }
    currentParent = currentParent.parentElement
  }

  return {
    id: ids.get(element) || '',
    parentId,
    tag: element.tagName.toLowerCase(),
    slot: element.getAttribute('data-slot'),
    type: inferType(element),
    variant: element.getAttribute('data-slot') === 'button' ? inferButtonVariant(element) : null,
    size:
      element.getAttribute('data-slot') === 'button'
        ? inferButtonSize(element)
        : element.getAttribute('data-size'),
    role: inferRole(element),
    classes: Array.from(element.classList),
    text: textForElement(element),
    bbox: toBbox(rect, targetRect),
    styles: {
      backgroundColor: resolveColor(style.backgroundColor),
      color: resolveColor(style.color),
      borderColor: resolveColor(style.borderColor),
      borderRadius: parseNumber(style.borderTopLeftRadius),
      boxShadow: style.boxShadow === 'none' ? null : style.boxShadow,
      fontFamily: style.fontFamily || null,
      fontSize: parseNumber(style.fontSize),
      fontWeight: parseNumber(style.fontWeight),
      lineHeight: parseLineHeight(style.lineHeight, style.fontSize),
      paddingTop: parseNumber(style.paddingTop),
      paddingRight: parseNumber(style.paddingRight),
      paddingBottom: parseNumber(style.paddingBottom),
      paddingLeft: parseNumber(style.paddingLeft),
      gap: parseNumber(style.gap),
      opacity: parseNumber(style.opacity),
    },
    attributes: Object.fromEntries(
      ['data-variant', 'data-size', 'type', 'aria-label', 'role', 'href']
        .map((name) => [name, element.getAttribute(name)])
        .filter((entry) => Boolean(entry[1]))
    ),
    children: [],
  }
})

const nodeMap = new Map(nodes.map((node) => [node.id, node]))
nodes.forEach((node) => {
  if (node.parentId) {
    const parent = nodeMap.get(node.parentId)
    if (parent) {
      parent.children.push(node.id)
    }
  }
})

const textRegions = []
const walker = document.createTreeWalker(captureTarget, NodeFilter.SHOW_TEXT, {
  acceptNode(node) {
    if (!(node.parentElement instanceof HTMLElement)) {
      return NodeFilter.FILTER_REJECT
    }

    const text = normalize(node.textContent)
    if (!text) {
      return NodeFilter.FILTER_REJECT
    }

    if (!isVisible(node.parentElement)) {
      return NodeFilter.FILTER_REJECT
    }

    return NodeFilter.FILTER_ACCEPT
  },
})

let textIndex = 0
while (walker.nextNode()) {
  const textNode = walker.currentNode
  const parent = textNode.parentElement
  if (!parent) {
    continue
  }

  const range = document.createRange()
  range.selectNodeContents(textNode)
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0
  )
  if (rects.length === 0) {
    continue
  }

  const union = rects.reduce((accumulator, rect) => ({
    left: Math.min(accumulator.left, rect.left),
    top: Math.min(accumulator.top, rect.top),
    right: Math.max(accumulator.right, rect.right),
    bottom: Math.max(accumulator.bottom, rect.bottom),
  }))

  let parentId = null
  let currentParent = parent
  while (currentParent) {
    const match = ids.get(currentParent)
    if (match) {
      parentId = match
      break
    }
    currentParent = currentParent.parentElement
  }

  const style = getComputedStyle(parent)
  textRegions.push({
    id: 'text_' + String(++textIndex).padStart(4, '0'),
    parentId,
    bbox: toBbox(union, targetRect),
    text: normalize(textNode.textContent),
    fontFamily: style.fontFamily || null,
    fontSize: parseNumber(style.fontSize),
    fontWeight: parseNumber(style.fontWeight),
    lineHeight: parseLineHeight(style.lineHeight, style.fontSize),
    color: resolveColor(style.color),
  })
}

const rootStyle = getComputedStyle(document.documentElement)
const rootMetrics = {
  spacingBasePx: measurePx('width', 'var(--spacing)'),
  spacingScale: Object.fromEntries(
    [
      ['1', 1],
      ['1_5', 1.5],
      ['2', 2],
      ['2_5', 2.5],
      ['3', 3],
      ['4', 4],
      ['5', 5],
      ['6', 6],
      ['7', 7],
      ['8', 8],
      ['10', 10],
      ['12', 12],
    ].map(([key, multiplier]) => [
      key,
      measurePx('width', 'calc(var(--spacing) * ' + multiplier + ')'),
    ])
  ),
  radiusScale: {
    xs: measureRadius('var(--radius-xs)'),
    sm: measureRadius('var(--radius-sm)'),
    md: measureRadius('var(--radius-md)'),
    lg: measureRadius('var(--radius-lg)'),
    xl: measureRadius('var(--radius-xl)'),
  },
  fontFamilies: {
    sans: rootStyle.getPropertyValue('--font-sans').trim() || null,
    mono: rootStyle.getPropertyValue('--font-mono').trim() || null,
    serif: rootStyle.getPropertyValue('--font-serif').trim() || null,
  },
  bodyFontFamily: getComputedStyle(document.body).fontFamily || null,
}

return {
  capture: {
    width: round(targetRect.width),
    height: round(targetRect.height),
  },
  rootMetrics,
  nodes,
  textRegions,
}
`

async function evaluatePageScript<TArgs, TResult>(
  page: Page,
  source: string,
  args: TArgs
) {
  return page.evaluate(
    ({ scriptSource, scriptArgs }) => {
      return Function("args", scriptSource)(scriptArgs) as TResult
    },
    {
      scriptSource: source,
      scriptArgs: args,
    }
  )
}

async function resolveThemeColors(
  page: Page,
  config: RenderConfig
) {
  const registryTheme = buildRegistryTheme({
    ...DEFAULT_CONFIG,
    base: config.base,
    style: config.style,
    baseColor: config.baseColor,
    theme: config.theme,
    iconLibrary: config.iconLibrary,
    font: config.font,
    item: config.item,
    rtl: config.rtl,
    menuAccent: config.menuAccent,
    menuColor: config.menuColor,
    radius: config.radius,
  })

  const resolved = await evaluatePageScript<
    { light: Record<string, string>; dark: Record<string, string> },
    ThemeResolution
  >(
    page,
    RESOLVE_THEME_COLORS_SOURCE,
    {
      light: registryTheme.cssVars.light ?? {},
      dark: registryTheme.cssVars.dark ?? {},
    }
  )

  return buildThemeResolution(registryTheme, resolved)
}

async function writeSystemFiles(
  outputDir: string,
  sample: DatasetSample,
  sampleDir: string,
  tokens: TokensFile,
  target: TargetFile
) {
  const configPath = path.join(sampleDir, "config.json")
  const themeCssPath = path.join(sampleDir, "theme.css")
  const tokensPath = path.join(sampleDir, "tokens.json")
  const targetPath = path.join(sampleDir, "target.json")

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        sample_id: sample.sampleId,
        system_id: sample.systemId,
        preset: sample.preset,
        url: sample.url,
        config: sample.config,
        target_config: sample.target,
      },
      null,
      2
    )
  )

  await fs.writeFile(themeCssPath, buildThemeCss(sample.config))
  await fs.writeFile(tokensPath, JSON.stringify(tokens, null, 2))
  await fs.writeFile(targetPath, JSON.stringify(target, null, 2))

  return {
    configPath: toManifestPath(configPath, outputDir),
    themeCssPath: toManifestPath(themeCssPath, outputDir),
    tokensPath: toManifestPath(tokensPath, outputDir),
    targetPath: toManifestPath(targetPath, outputDir),
  } satisfies SampleFilePaths
}

async function extractScreenArtifacts(page: Page) {
  return evaluatePageScript<null, ScreenExtraction>(
    page,
    EXTRACT_SCREEN_ARTIFACTS_SOURCE,
    null
  )
}

async function readJpegSize(filePath: string) {
  const buffer = await fs.readFile(filePath)

  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error(`Expected a JPEG image at ${filePath}`)
  }

  let offset = 2
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }

    const marker = buffer[offset + 1]
    if (marker === 0xd9 || marker === 0xda) {
      break
    }

    const length = buffer.readUInt16BE(offset + 2)
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }

    offset += 2 + length
  }

  throw new Error(`Could not read JPEG dimensions for ${filePath}`)
}

async function writeScreenFiles(
  outputDir: string,
  sample: DatasetSample,
  sampleDir: string,
  screenId: string,
  appearance: Appearance,
  screen: ScreenExtraction,
  tokens: TokensFile
) {
  const fileStem = `${screenId.split(".").slice(-2).join("-")}`
  const domPath = path.join(sampleDir, `${fileStem}.dom.json`)
  const boxesPath = path.join(sampleDir, `${fileStem}.boxes.json`)
  const observationsPath = path.join(sampleDir, `${fileStem}.observations.json`)

  const domFile = buildDomFile(sample, screenId, screen)
  const boxesFile = buildBoxesFile(sample, screenId, appearance, screen, tokens)
  const observationsFile = buildObservationsFile(
    sample,
    screenId,
    appearance,
    screen,
    tokens
  )

  await fs.writeFile(domPath, JSON.stringify(domFile, null, 2))
  await fs.writeFile(boxesPath, JSON.stringify(boxesFile, null, 2))
  await fs.writeFile(observationsPath, JSON.stringify(observationsFile, null, 2))

  return {
    domPath: toManifestPath(domPath, outputDir),
    boxesPath: toManifestPath(boxesPath, outputDir),
    observationsPath: toManifestPath(observationsPath, outputDir),
  }
}

async function captureScreenImages(
  page: Page,
  outputDir: string,
  sample: DatasetSample,
  sampleDir: string,
  screenId: string,
  appearance: Appearance,
  viewport: ViewportProfile,
  qualities: number[]
) {
  const element = await page.$('[data-slot="capture-target"]')
  if (!element) {
    throw new Error(`Capture target not found for ${sample.sampleId}`)
  }

  const box = await element.boundingBox()
  if (!box) {
    throw new Error(`Could not measure capture target for ${sample.sampleId}`)
  }

  const filePrefix = `${viewport.name}-${appearance}`
  const captures: ManifestCaptureRecord[] = []

  for (const quality of qualities) {
    const fileName = `${filePrefix}-q${quality}.jpg`
    const screenshotPath = path.join(sampleDir, fileName)

    await page.screenshot({
      path: screenshotPath,
      type: "jpeg",
      quality,
      clip: box,
      captureBeyondViewport: true,
    })

    const outputSize = await readJpegSize(screenshotPath)
    captures.push({
      captureId: `${screenId}.q${quality}`,
      quality,
      imagePath: toManifestPath(screenshotPath, outputDir),
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
      format: "jpeg",
    })
  }

  return {
    captureWidth: roundNumber(box.width),
    captureHeight: roundNumber(box.height),
    captures,
  }
}

function buildManifestJsonl(manifest: DatasetManifest) {
  const lines: string[] = []

  manifest.samples.forEach((sample) => {
    sample.screens.forEach((screen) => {
      screen.captures.forEach((capture) => {
        const record: ManifestJsonlRecord = {
          schemaVersion: manifest.schemaVersion,
          sampleId: sample.sampleId,
          systemId: sample.systemId,
          screenId: screen.screenId,
          captureId: capture.captureId,
          preset: sample.preset,
          image: capture.imagePath,
          configPath: sample.files.configPath,
          themeCssPath: sample.files.themeCssPath,
          tokensPath: sample.files.tokensPath,
          targetPath: sample.files.targetPath,
          domPath: screen.files.domPath,
          boxesPath: screen.files.boxesPath,
          observationsPath: screen.files.observationsPath,
          url: sample.previewUrl,
          appearance: screen.appearance,
          quality: capture.quality,
          viewport: screen.viewport,
          captureWidth: screen.captureWidth,
          captureHeight: screen.captureHeight,
          outputWidth: capture.outputWidth,
          outputHeight: capture.outputHeight,
          target: {
            ...sample.targetConfig,
            appearance: screen.appearance,
          },
        }

        lines.push(JSON.stringify(record))
      })
    })
  })

  return `${lines.join("\n")}\n`
}

async function captureDataset(options: CliOptions) {
  const samples = createSamples(options)
  await ensureEmptyOutputDir(options.outputDir, options.force)

  const samplesDir = path.join(options.outputDir, "samples")
  await fs.mkdir(samplesDir, { recursive: true })

  const browser = await puppeteer.launch()

  try {
    const manifestSamples: ManifestSampleRecord[] = []
    let imageCount = 0
    let screenCount = 0

    for (const [sampleIndex, sample] of samples.entries()) {
      console.log(
        `[${sampleIndex + 1}/${samples.length}] ${sample.sampleId} ${sample.preset} -> ${sample.target.style}/${sample.target.theme}/${sample.target.baseColor}`
      )

      const sampleDir = path.join(samplesDir, sample.sampleId)
      await fs.mkdir(sampleDir, { recursive: true })

      let tokensFile: TokensFile | null = null
      let targetFile: TargetFile | null = null
      let sampleFiles: SampleFilePaths | null = null
      const screenRecords: ManifestScreenRecord[] = []

      for (const viewport of options.viewports) {
        const page = await browser.newPage()

        try {
          await page.setViewport({
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: viewport.deviceScaleFactor,
          })
          await page.emulateMediaFeatures([
            { name: "prefers-reduced-motion", value: "reduce" },
          ])

          try {
            await page.goto(sample.url, { waitUntil: "networkidle2" })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes("ERR_CONNECTION_REFUSED")) {
              throw new Error(
                `Could not reach ${options.baseUrl}. Start the app with "pnpm --filter=v4 dev" before running this script.`
              )
            }

            throw new Error(
              `Could not load ${sample.url}. Make sure the app is running at ${options.baseUrl} before starting capture. Original error: ${message}`
            )
          }

          await preparePageForCapture(page, viewport)

          for (const appearance of options.appearances) {
            await setAppearanceAndPrepare(page, appearance, viewport)

            const screenId = `${sample.systemId}.${viewport.name}.${appearance}`
            const screenExtraction = await extractScreenArtifacts(page)

            if (!tokensFile || !targetFile || !sampleFiles) {
              const themeResolution = await resolveThemeColors(page, sample.config)
              tokensFile = buildTokensFile(sample, screenExtraction, themeResolution)
              targetFile = buildTargetFile(sample, tokensFile)
              sampleFiles = await writeSystemFiles(
                options.outputDir,
                sample,
                sampleDir,
                tokensFile,
                targetFile
              )
            }

            const screenFiles = await writeScreenFiles(
              options.outputDir,
              sample,
              sampleDir,
              screenId,
              appearance,
              screenExtraction,
              tokensFile
            )

            const captureData = await captureScreenImages(
              page,
              options.outputDir,
              sample,
              sampleDir,
              screenId,
              appearance,
              viewport,
              options.qualities
            )

            screenRecords.push({
              screenId,
              appearance,
              viewport,
              captureWidth: captureData.captureWidth,
              captureHeight: captureData.captureHeight,
              coordinateSpace: "image_pixels_relative_to_capture_target",
              files: screenFiles,
              captures: captureData.captures,
            })

            screenCount++
            imageCount += captureData.captures.length
          }
        } finally {
          await page.close()
        }
      }

      if (!sampleFiles) {
        throw new Error(`Failed to write system files for ${sample.sampleId}`)
      }

      manifestSamples.push({
        sampleId: sample.sampleId,
        systemId: sample.systemId,
        preset: sample.preset,
        previewUrl: sample.url,
        config: sample.config,
        targetConfig: sample.target,
        files: sampleFiles,
        screens: screenRecords,
      })

      console.log(
        `    wrote ${screenRecords.length} screens / ${screenRecords.reduce((count, screen) => count + screen.captures.length, 0)} images`
      )
    }

    const manifest: DatasetManifest = {
      schemaVersion: DATASET_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      generator: {
        script: "apps/v4/scripts/capture-theme-training.ts",
        baseUrl: options.baseUrl,
        item: options.item,
        seed: options.seed,
      },
      captureDefaults: {
        appearances: options.appearances,
        qualities: options.qualities,
        viewports: options.viewports,
        base: options.base ?? null,
      },
      totals: {
        requestedSamples: options.count,
        sampleCount: manifestSamples.length,
        screenCount,
        imageCount,
      },
      provenance: {
        config: "authoritative generator input for the sampled shadcn system",
        themeCss:
          "authoritative registry theme CSS built from the sampled config",
        tokens:
          "derived from authoritative registry theme vars plus live rendered CSS metrics",
        dom: "live rendered DOM subset under the capture target",
        boxes:
          "live rendered bounding boxes relative to the capture target image origin",
        observations:
          "live rendered measurements derived from computed styles and layout geometry",
        target: "normalized exact training target derived from the sampled config",
      },
      samples: manifestSamples,
    }

    const manifestPath = path.join(options.outputDir, "manifest.json")
    const manifestJsonlPath = path.join(options.outputDir, "manifest.jsonl")
    const datasetPath = path.join(options.outputDir, "dataset.json")

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    await fs.writeFile(manifestJsonlPath, buildManifestJsonl(manifest))
    await fs.writeFile(
      datasetPath,
      JSON.stringify(
        {
          schemaVersion: DATASET_SCHEMA_VERSION,
          generatedAt: manifest.generatedAt,
          seed: options.seed,
          baseUrl: options.baseUrl,
          item: options.item,
          requestedSamples: options.count,
          sampleCount: manifest.totals.sampleCount,
          screenCount: manifest.totals.screenCount,
          imageCount: manifest.totals.imageCount,
          outputDir: options.outputDir,
          manifestPath: toManifestPath(manifestPath, options.outputDir),
          manifestJsonlPath: toManifestPath(manifestJsonlPath, options.outputDir),
          appearances: options.appearances,
          qualities: options.qualities,
          viewports: options.viewports,
          base: options.base ?? null,
        },
        null,
        2
      )
    )
  } finally {
    await browser.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  console.log("Generating theme training dataset...")
  console.log(`   base URL: ${options.baseUrl}`)
  console.log(`   item: ${options.item}`)
  console.log(`   samples: ${options.count}`)
  console.log(`   seed: ${options.seed}`)
  console.log(`   output: ${options.outputDir}`)

  await captureDataset(options)

  console.log("Done.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
