// Brand configuration for Bequest Digital LLC.
//
// Colors are extracted from the live mybequestdigital.com stylesheet
// (/assets/index-DK8NB9SR.css, fetched 2026-07-18). The site defines them as
// HSL design tokens; the hex equivalents are below with the original HSL in
// comments. If the site rebrands, update this file — every template reads
// from here.
export default {
  name: 'Bequest Digital',
  wordmark: 'BEQUEST DIGITAL',
  url: 'https://mybequestdigital.com',

  colors: {
    forestDark: '#0D2118', // --forest-dark: hsl(147 45% 9%)  — primary dark canvas
    forest: '#153325', //     --forest:      hsl(147 42% 14%) — primary brand green
    forestLight: '#264A3A', // --forest-light: hsl(147 32% 22%)
    gold: '#CBA84D', //       --gold:        hsl(43 55% 55%)  — accent
    goldLight: '#E0C685', //  --gold-light:  hsl(43 60% 70%)
    goldMuted: '#AC9353', //  --gold-muted:  hsl(43 35% 50%)
    cream: '#F6F4EE', //      --cream:       hsl(43 33% 95%)  — light text on dark
    creamDark: '#ECE8DF', //  --cream-dark:  hsl(40 25% 90%)
    ivory: '#FAF8F5', //      --ivory / --background: hsl(45 30% 97%)
  },

  fonts: {
    // Site tokens: --font-serif / --font-sans
    serif: "'Cormorant Garamond', Georgia, serif",
    sans: "'Source Sans 3', system-ui, sans-serif",
    googleImport:
      'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Source+Sans+3:wght@400;600;700&display=swap',
  },

  // Poaster render surface (our own product, poaster.co) — used by the
  // ig-native template family in generate-image.js. The brandRow mirrors the
  // palette/fonts above in Poaster's brand-row shape; keep the two in sync.
  poaster: {
    renderBase: 'https://poaster.co',
    presets: ['editorialSerif', 'solidCard', 'memeCaps', 'typewriter', 'whitePanel', 'script', 'pollCard'],
    brandRow: {
      id: 'bequest-social',
      label: 'Bequest Digital',
      family: 'editorial',
      wordmark: 'Bequest Digital',
      eyebrow: 'Bequest Digital',
      site_host: 'mybequestdigital.com',
      site_url: 'https://mybequestdigital.com',
      medallion_url: null,
      fallback_hero_url: null,
      fallback_heroes: [],
      colors: {
        primary: '#153325', gold: '#CBA84D', charcoal: '#0D2118',
        ink: '#0D2118', paper: '#F6F4EE', paperWarm: '#F6F4EE',
        __fonts: {
          headline: 'Cormorant Garamond', body: 'Source Sans 3', source: 'google',
          headlineSource: 'google', bodySource: 'google',
          googleFamilies: ['Cormorant Garamond', 'Source Sans 3'], faces: [], unavailable: [],
        },
      },
      allowed_post_types: ['igNative'],
    },
  },

  // IG hashtag pool. Generation may ONLY choose from this list (base set comes
  // from the calendar's Standing Notes; the rest are approved extensions).
  hashtags: [
    'churchmarketing',
    'nonprofitmarketing',
    'christianbusiness',
    'smallbusinessmarketing',
    'ministrymarketing',
    'churchcommunications',
    'nonprofitleadership',
    'faithbasedbusiness',
    // Added 10/21/26 for POASTER product posts (poaster.co promotion).
    'socialmediamarketing',
    'contentmarketing',
    'marketingtools',
  ],
};
