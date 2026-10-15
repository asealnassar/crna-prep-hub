/**
 * What the Studio can do with a school's requirement.
 *
 * ---------------------------------------------------------------------------
 * ONE RESOLVER, READ FROM THE CANONICAL RECORD
 * ---------------------------------------------------------------------------
 * Every school gets a different editor and a different compliance panel, and
 * the difference comes entirely from its own requirement fields. There is no
 * school named anywhere in this file and there must never be one: a school with
 * a 1.5-page double-spaced limit behaves the way it does because its record
 * says `max_pages = 1.5` and `page_spacing = double`, not because it is Boston
 * College.
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACED THE BLANKET NOTICE
 * ---------------------------------------------------------------------------
 * The editor used to tell every applicant that it "counts words and characters
 * only" and could not check page count, spacing, font or margins. That was true
 * of a textarea. It is not true of a laid-out page, and a product that
 * understates what it knows is as misleading as one that overstates it -- an
 * applicant who is told the page count cannot be checked will go and check it,
 * which is the work the Studio was built to do for them.
 *
 * So capability is resolved per FIELD, in three states:
 *
 *   measured  The Studio observes it in the rendered document and reports a
 *             figure that can come out either way. Words, characters, pages.
 *
 *   applied   The Studio renders it, deterministically, with no way to turn it
 *             off. Spacing, font size, margins. NOT a passed check: nothing was
 *             tested, so calling it one would imply a measurement that never
 *             happened.
 *
 *   substituted  The Studio renders something close enough that the layout is
 *             trustworthy, but it is not what was asked for. Only a font family
 *             reaches this state, and it is reported as its own thing rather
 *             than folded into either neighbour -- see fontRegistry.ts.
 *
 *   manual    The school stated it and the Studio can neither observe nor
 *             render it. Named individually, with the school's own words.
 *             This is all that is left of the old notice.
 *
 * WHICH STATE A FIELD IS IN IS A FACT ABOUT THIS PRODUCT, not about the school
 * -- so it lives in one table, below. A school only decides WHETHER a field is
 * constrained, never what we can do about it.
 */
import {
  SPACING_LABELS, type ConstraintKind, type Constraints, type Spacing,
  hasStructuredLengthBound,
} from '../requirements/constraints.ts'
import {
  resolveGeometry, type LayoutSource, type PageGeometry,
} from './geometry.ts'
import {
  resolveFontChoice, resolveSupportedFontFamily,
  type FontChoiceResolution, type FontResolution,
} from './fontRegistry.ts'

/** What the Studio can do with a stated requirement. */
export type Capability = 'measured' | 'applied' | 'substituted' | 'manual'

/**
 * The fields a requirement can constrain.
 *
 * FINER THAN ConstraintKind, which lumps the font family together with the
 * font size. They are not the same capability: a school's 12pt is applied to
 * the page, and its Times New Roman cannot be, because one face is embedded.
 * Lumping them forced both into whichever state was worse.
 */
export type CapabilityField =
  | 'words' | 'characters' | 'pages' | 'spacing'
  | 'font-size' | 'font-family' | 'margins' | 'paper'
  | 'indent'
  | 'citation' | 'unenforced-length' | 'other'

/**
 * The fields whose capability is the same whatever a school stated.
 *
 * FONT FAMILY IS NOT ONE OF THEM, and that is the point. What the Studio can do
 * with a family depends on WHICH family: one we embed is applied, one we can
 * only approximate is substituted and disclosed, one we do not recognise is
 * handed back. A single table entry would have to pick the worst case for all
 * three, which is exactly the over-broad 'manual' this replaced.
 */
export type FixedField = Exclude<CapabilityField, 'font-family'>

/**
 * What this product can do with each field, whoever states it.
 *
 * THE ONE PLACE THIS IS DECIDED. A field moves between states when the product
 * gains or loses an ability -- pages moved from manual to measured when the
 * editor started laying out the page -- and everything downstream follows from
 * here rather than from its own idea of what the editor can see.
 */
export const STUDIO_CAPABILITIES: Readonly<Record<FixedField, Capability>> = {
  words: 'measured',
  characters: 'measured',
  // MEASURED BECAUSE THE STUDIO LAYS THE PAGE OUT. The figure is read from the
  // rendered document, not estimated from a word count.
  pages: 'measured',
  spacing: 'applied',
  'font-size': 'applied',
  margins: 'applied',
  indent: 'applied',
  paper: 'applied',
  citation: 'manual',
  'unenforced-length': 'manual',
  other: 'manual',
}

/** A lower and upper bound, either of which may be absent. */
export interface Bound {
  readonly min: number | null
  readonly max: number | null
}

export interface CharacterBound extends Bound {
  /** Whether spaces count toward the limit, when the school said. */
  readonly spacesCount: boolean | null
}

export interface PageBound extends Bound {
  /** The spacing the page is laid out in, and whether the school chose it. */
  readonly spacing: Spacing
  readonly spacingSource: LayoutSource
  /**
   * Whether the maximum falls inside a page rather than at the foot of one.
   *
   * 1.5 PAGES IS HALF OF PAGE TWO, and the allowance line is drawn there. A
   * whole number ends at the foot of its page. The distinction is the school's,
   * not a special case: 0.5 and 2.25 behave the same way.
   */
  readonly fractionalMax: boolean
}

/** A layout value the Studio renders, and where it came from. */
export interface AppliedLayout {
  readonly field: CapabilityField
  readonly label: string
  readonly source: LayoutSource
}

/** A stated requirement the Studio can neither observe nor render. */
export interface ManualReviewItem {
  readonly id: string
  readonly field: CapabilityField
  /** The school's own words. */
  readonly label: string
  /** What the applicant has to do about it. */
  readonly reason: string
}

export interface RequirementCapabilities {
  /** Live word bounds, or null when the school stated none. */
  readonly words: Bound | null
  readonly characters: CharacterBound | null
  readonly pages: PageBound | null
  /**
   * Whether the writing surface is a laid-out page.
   *
   * TRUE WHEN THE SCHOOL SAID ANYTHING ABOUT THE PHYSICAL PAGE -- a page bound,
   * a spacing, margins, a font size -- because those are applied by rendering
   * the page, and a textarea would quietly drop them. A school that stated only
   * a word count gets the plain surface: there is no page requirement to honour
   * and MANUFACTURING A PAGE LIMIT FROM A WORD COUNT is the estimate this
   * product refuses to make.
   */
  readonly paginated: boolean
  /** The page the Studio will render, with per-property provenance. */
  readonly geometry: PageGeometry
  /** Layout the Studio applies, school-stated first. */
  readonly applied: readonly AppliedLayout[]
  /**
   * What the Studio is doing that the school did not ask for, in sentences.
   *
   * SEPARATE FROM `applied` ON PURPOSE. "Required by this school" and "what we
   * render" are two different claims, and a panel that ran them together would
   * be the silent substitution this whole model exists to prevent. Empty
   * whenever the Studio is simply doing what was asked.
   */
  readonly rendering: readonly string[]
  /**
   * What the school asked for in a font, and what will actually be rendered.
   *
   * ALWAYS PRESENT, because a page is always drawn in something. When the
   * school stated nothing this says so, and the family is disclosed among the
   * Studio defaults rather than passed off as a requirement.
   */
  readonly font: FontResolution | FontChoiceResolution
  /** Everything stated that still needs a human. */
  readonly manualReview: readonly ManualReviewItem[]
}

/** Whether this field is in the given state. Reads as a sentence at call sites. */
export function capabilityOf(field: FixedField): Capability {
  return STUDIO_CAPABILITIES[field]
}

/**
 * What the Studio can do with THIS font family.
 *
 * The one field whose answer depends on the value, which is why it is a
 * function and not a table row.
 */
export function fontFamilyCapability(requested: string | null): Capability {
  const support = resolveSupportedFontFamily(requested).support
  if (support === 'exact') return 'applied'
  if (support === 'substituted') return 'substituted'
  return 'manual'
}

/**
 * The field a coarser ConstraintKind stands for.
 *
 * 'font' COVERS TWO FIELDS with different capabilities -- the size is applied,
 * the family cannot be -- so it maps to the size and the family is resolved
 * from the typography directly. Nothing downstream of this mapping asks a
 * question the choice could answer wrongly: both are outside 'measured', which
 * is all the coarse kind is ever used to decide.
 */
const FIELD_FOR_KIND: Readonly<Record<ConstraintKind, FixedField>> = {
  words: 'words',
  characters: 'characters',
  pages: 'pages',
  spacing: 'spacing',
  font: 'font-size',
  margins: 'margins',
  citation: 'citation',
  'unenforced-length': 'unenforced-length',
  other: 'other',
}

/**
 * Whether a stated requirement of this kind produces a live figure.
 *
 * THE REPLACEMENT FOR measurableInEditor, which answered "words and characters,
 * and nothing else" because that was all a textarea could see. Pages joined
 * them when the editor started rendering the page.
 */
export function measuredKind(kind: ConstraintKind): boolean {
  return capabilityOfKind(kind) === 'measured'
}

/**
 * What the Studio does about a requirement of this kind.
 *
 * THE SAME MAPPING measuredKind USES, exposed because "is it counted" is not
 * the only question a surface asks. Telling an applicant which of their
 * school's requirements this editor APPLIES, as against which are theirs to
 * apply, needs the capability itself and not a boolean derived from it.
 */
export function capabilityOfKind(kind: ConstraintKind): Capability {
  return capabilityOf(FIELD_FOR_KIND[kind])
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === 'number' && value > 0 ? value : null

/**
 * Everything the Studio can say about one school's requirement.
 *
 * TAKES THE CANONICAL CONSTRAINTS AND NOTHING ELSE. No school name, no catalog
 * row, no feature flag -- so a school that behaves wrongly is a record that is
 * wrong, which is a thing the admin catalog can fix without a deploy.
 *
 * `null` IS A DRAFT WITH NO REQUIREMENT: no bounds, no pagination, nothing to
 * review, and the Studio's own defaults throughout.
 */
export function resolveRequirementCapabilities(
  constraints: Constraints | null,
  /**
   * The face the document is laid out in, when one has been settled on.
   *
   * PASSED THROUGH TO resolveGeometry AND NOWHERE ELSE. Everything downstream
   * -- the line box, the page count, the allowance the compliance rows are
   * measured against -- is computed from the geometry, so threading the font
   * to that one call is what makes a font change move the page limit as well
   * as the page.
   *
   * OMITTED MEANS THE STUDIO DEFAULT, so every existing caller is unchanged.
   */
  chosenFont?: Parameters<typeof resolveGeometry>[1],
): RequirementCapabilities {
  const geometry = resolveGeometry(constraints, chosenFont)
  /*
    A REQUIRED FAMILY AND A PERMITTED SET ARE DIFFERENT QUESTIONS.

    Migration 010 guarantees only one of them is ever populated, so this reads
    the set when there is one and the scalar otherwise. A set is the better
    case: the Studio may pick the option it honours best, so a school offering
    a choice can be met exactly where the same school naming one font we do not
    ship could not.
  */
  const typographyRaw = constraints?.typography ?? null
  /*
    THE PROFILE'S FONT IS A REQUESTED FONT, and goes through the same
    registry as a school's own.

    APA permits 12-point Times New Roman among others, and that is the
    combination this profile selects. The Studio renders Tinos, which is NOT
    Times New Roman -- so the resolution comes back `substituted`, exactly as
    it would for a school that named the font itself, and the panel says so.
    Calling it applied because Tinos shares the metrics would be the silent
    swap this state exists to prevent.

    AN EXPLICIT SCHOOL FONT STILL WINS, because a school that named one made
    a requirement and a standard they invoked does not overrule it.
  */
  const profileFont = geometry.formatProfile?.fontFamily ?? null
  const font: FontResolution = typographyRaw?.fontFamilyOptions != null
    ? resolveFontChoice(typographyRaw.fontFamilyOptions)
    : resolveSupportedFontFamily(typographyRaw?.fontFamily ?? profileFont)
  const words = constraints?.words ?? null
  const characters = constraints?.characters ?? null
  const pages = constraints?.pages ?? null
  const typography = constraints?.typography ?? null

  const wordBound: Bound | null = words === null ? null
    : bound(words.min, words.max)
  const characterBound: CharacterBound | null = characters === null ? null
    : { ...bound(characters.min, characters.max), spacesCount: characters.spacesCount }

  // A PAGE BOUND IS ONLY A PAGE BOUND IF IT BOUNDS SOMETHING. A row carrying a
  // spacing and no numbers still lays the page out; it just has nothing to
  // measure against, so no page figure is shown.
  const pageMin = positive(pages?.min)
  const pageMax = positive(pages?.max)
  const pageBound: PageBound | null = pageMin === null && pageMax === null ? null : {
    min: pageMin,
    max: pageMax,
    spacing: geometry.spacing.value,
    spacingSource: geometry.spacing.source,
    fractionalMax: pageMax !== null && !Number.isInteger(pageMax),
  }

  // WHAT THE SCHOOL SAID ABOUT THE PHYSICAL PAGE. Any one of these is enough to
  // make the page real, because each is honoured by rendering it.
  const statesLayout = geometry.formatProfile !== null
    || pageBound !== null
    || pages?.spacing != null
    || positive(typography?.fontSizePt) !== null
    || typography?.fontSizePtOptions != null
    || typography?.fontFamilyOptions != null
    || (typeof typography?.marginsInches === 'number' && typography.marginsInches >= 0)

  return {
    words: wordBound,
    characters: characterBound,
    pages: pageBound,
    paginated: statesLayout,
    geometry,
    applied: appliedLayout(geometry, font, typographyRaw?.fontSizePtOptions ?? null),
    rendering: renderingNotes(geometry, font),
    font,
    manualReview: manualReview(constraints, font),
  }
}

function bound(min: number | null, max: number | null): Bound {
  return { min: positive(min), max: positive(max) }
}

/**
 * The layout the Studio renders, each line marked school or default.
 *
 * READ OFF THE RESOLVED GEOMETRY, never off the constraints again. The geometry
 * is what the page is actually drawn with, so a property that moved from a
 * default to a school value cannot be described here as the other one.
 */
function appliedLayout(
  geometry: PageGeometry,
  font: FontResolution,
  sizeOptions: readonly number[] | null,
): readonly AppliedLayout[] {
  const out: AppliedLayout[] = [
    { field: 'paper', label: paperLabel(geometry), source: geometry.paperWidthIn.source },
    // ALWAYS OURS, AND ALWAYS NAMED. A school that stated a family gets it back
    // as a manual-review line, because we cannot render it -- but the page is
    // still drawn in the face we embed, and the page count depends on which one
    // that is, so it is disclosed rather than left to be assumed.
    fontFamilyLine(font),
    {
      field: 'indent',
      label: `${geometry.firstLineIndentIn.value}-inch first-line indent`,
      source: geometry.firstLineIndentIn.source,
    },
    {
      field: 'font-size',
      // A PERMITTED SET IS SHOWN AS THE SET. Printing only the size we picked
      // would read as the school's requirement, which it is not.
      label: geometry.fontSizePt.source === 'school-choice' && sizeOptions !== null
        ? `${sizeOptions.join(' or ')} pt`
        : `${geometry.fontSizePt.value} pt`,
      source: geometry.fontSizePt.source,
    },
    {
      field: 'margins',
      label: `${geometry.marginsIn.value}-inch margins`,
      source: geometry.marginsIn.source,
    },
    {
      field: 'spacing',
      label: capitalise(SPACING_LABELS[geometry.spacing.value]),
      source: geometry.spacing.source,
    },
  ]
  // AN INDENT OF ZERO IS NOT A RULE ANYBODY CHOSE, so it is not listed at all.
  const shown = out.filter((x) => !(x.field === 'indent' && x.source === 'studio-default'))
  // SCHOOL-STATED FIRST, PERMITTED NEXT, OURS LAST. The applicant is reading to
  // find what this school demanded; our defaults are the background.
  const rank = (x: AppliedLayout) =>
    x.source === 'school' ? 0
      : x.source === 'school-choice' ? 1
        : x.source === 'format-profile' ? 2 : 3
  return [...shown].sort((a, b) => rank(a) - rank(b))
}

/**
 * The font line, in whichever of the three registers applies.
 *
 * THE SCHOOL'S WORDING WHENEVER THE SCHOOL SAID ANYTHING. Printing the family
 * we render under "required by the school" would attribute our choice to them.
 */
function fontFamilyLine(font: FontResolution): AppliedLayout {
  const permitted = (font as { permitted?: readonly string[] }).permitted
  if (permitted !== undefined && permitted.length > 0) {
    return {
      field: 'font-family',
      label: permitted.join(' or '),
      source: 'school-choice',
    }
  }
  if (font.support === 'exact' && font.requested !== null) {
    return { field: 'font-family', label: font.requested, source: 'school' }
  }
  // A SUBSTITUTED OR UNRECOGNISED FAMILY IS NOT LISTED AS MET. The face we
  // render is ours, and the requirement gets its own row.
  return { field: 'font-family', label: font.rendered.family, source: 'studio-default' }
}

/**
 * What the Studio is doing beyond what was asked, said plainly.
 *
 * NEVER IMPLIES PERMISSION. A substitution sentence names the font the school
 * required or permitted and states that the face we render does not satisfy it.
 */
function renderingNotes(
  geometry: PageGeometry,
  font: FontResolution,
): readonly string[] {
  const out: string[] = []
  /*
    THE PROFILE, NAMED, WITH WHAT IT DOES AND DOES NOT DO.

    A school that said "APA format" chose a standard, not a set of numbers, so
    the layout is attributed to the standard rather than quoted back as their
    own instruction -- and the parts the Studio does NOT do are listed in the
    same breath. Applying six rules silently and omitting the seventh would
    read as full compliance.
  */
  const profile = geometry.formatProfile
  if (profile !== null) {
    // JOINED AS WRITTEN. Lowercasing the list to make it read as one sentence
    // also lowercased "Times New Roman", which is a font's name.
    out.push(`Rendered to ${profile.label} body layout — `
      + `${profile.rules.map((rule) => rule.label).join('; ')}.`)
    for (const omitted of profile.notApplied) out.push(`${omitted.label}.`)
  }
  if (font.support === 'substituted' && font.disclosure !== null) {
    out.push(font.disclosure)
  }
  if (geometry.fontSizePt.source === 'school-choice') {
    out.push(`Rendering at ${geometry.fontSizePt.value} pt, which the school permits.`)
  }
  const chosen = (font as { chosen?: string | null }).chosen
  if (font.support === 'exact' && typeof chosen === 'string') {
    out.push(`Rendering in ${chosen}, which the school permits.`)
  }
  return out
}

function paperLabel(geometry: PageGeometry): string {
  const w = geometry.paperWidthIn.value
  const h = geometry.paperHeightIn.value
  return w === 8.5 && h === 11 ? 'US Letter' : `${w} × ${h} inches`
}

/**
 * Everything stated that the Studio cannot settle, named one at a time.
 *
 * THIS IS THE WHOLE OF WHAT THE BLANKET NOTICE BECAME. It is empty for a school
 * that stated only a page limit and a spacing, which is exactly the case the
 * old sentence got wrong -- it told those applicants that their page count
 * could not be checked while the Studio was counting their pages.
 */
function manualReview(
  constraints: Constraints | null,
  font: FontResolution,
): readonly ManualReviewItem[] {
  if (constraints === null) return []
  const out: ManualReviewItem[] = []

  // ONLY A FONT WE DO NOT RECOGNISE. One we render exactly is applied, and one
  // we can only approximate is disclosed as a substitution -- neither belongs
  // in a list of things the applicant has to do by hand.
  if (font.support === 'unsupported' && font.requested !== null) {
    out.push({
      id: `font-family:${font.requested}`,
      field: 'font-family',
      label: font.requested,
      reason: 'the Studio does not ship this font — set it in your final document',
    })
  }
  if (constraints.citation !== null) {
    out.push({
      id: `citation:${constraints.citation.statedAs}`,
      field: 'citation',
      label: constraints.citation.statedAs,
      reason: 'citation format is not checked by the Studio',
    })
  }
  /*
    AND ONLY WHILE NOTHING BOUNDS IT.

    The reason below -- "the Studio does not bound it" -- is a statement of
    fact, and it is false for a document whose figure was normalised into a
    word, character or page bound: the editor counts against that bound and
    the status bar says so. Listing the same requirement as something to check
    by hand told those applicants the opposite of what the counter was doing.
  */
  if (constraints.unenforcedLength !== null && !hasStructuredLengthBound(constraints)) {
    out.push({
      id: `unenforced-length:${constraints.unenforcedLength.text}`,
      field: 'unenforced-length',
      label: constraints.unenforcedLength.text,
      reason: 'stated as guidance, so the Studio does not bound it',
    })
  }
  for (const instruction of constraints.otherInstructions) {
    if (recordsNothingStated(instruction)) continue
    out.push({
      id: `other:${instruction}`,
      field: 'other',
      label: instruction,
      reason: 'not checked by the Studio',
    })
  }
  return out
}

/**
 * Whether a free-text instruction is the importer recording an ABSENCE.
 *
 * ---------------------------------------------------------------------------
 * "Not stated (typewritten)" IS NOT A REQUIREMENT
 * ---------------------------------------------------------------------------
 * The catalog importer uses this prefix to record that a school said nothing
 * about formatting. Six documents carry one. Passed through as a requirement it
 * produced the line
 *
 *     Not stated (typewritten) — not checked by the Studio
 *
 * which tells an applicant to go and verify something their school explicitly
 * did not ask for. That is the same error as the blanket notice, in miniature.
 *
 * MATCHED ON THE PREFIX, NOT ANYWHERE IN THE TEXT, and that distinction is
 * load-bearing: "Typewritten; font and margins not stated" also contains the
 * words, and IS a requirement -- it says the essay must be typewritten. Only an
 * instruction that OPENS by declaring nothing was stated is an absence.
 *
 * THIS IS NOT PROSE INFERENCE. It recognises one importer convention and
 * nothing else; an instruction it does not recognise is kept, untouched.
 */
function recordsNothingStated(instruction: string): boolean {
  return /^\s*not stated\b/i.test(instruction)
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)
}

