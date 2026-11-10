// Tailwind v3 fallback. On Tailwind v4, use tokens/theme.css instead and delete this file.
import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hud: '#0A0D11', well: '#0B0E12', ground: '#0E1116', surface: '#151A21', raised: '#1C232C',
        'line-soft': '#222A35', line: '#2A333F', 'line-strong': '#3A4452',
        'ink-dim': '#8592A3', 'ink-muted': '#A3AEBD', 'ink-soft': '#C7CFDA', ink: '#E6EAF0',
        you: '#F0B44C', 'you-ink': '#1A1405',
        st: {
          idle: '#8592A3', think: '#A99BF5', run: '#5AA9F0', you: '#F5B83D',
          blocked: '#C79A5B', error: '#F2706A', paused: '#B8C1CC', done: '#5CC98A',
        },
        diff: { add: '#8FE0B0', del: '#F7A39E' },
      },
      fontFamily: {
        display: ['"Chakra Petch"', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '12px', '2xl': '14px' },
      boxShadow: { raised: '0 12px 30px rgb(0 0 0 / 0.5)', drawer: '-24px 0 48px rgb(0 0 0 / 0.5)' },
      transitionTimingFunction: {
        standard: 'cubic-bezier(.2,.8,.2,1)', enter: 'cubic-bezier(0,0,.2,1)',
        exit: 'cubic-bezier(.4,0,1,1)', spring: 'cubic-bezier(.34,1.56,.64,1)',
      },
      transitionDuration: { instant: '80ms', fast: '160ms', base: '240ms', slow: '400ms', celebrate: '900ms' },
      keyframes: {
        attention: {
          '0%': { boxShadow: '0 0 0 0 rgb(245 184 61 / 0.6)' },
          '70%': { boxShadow: '0 0 0 10px rgb(245 184 61 / 0)' },
          '100%': { boxShadow: '0 0 0 0 rgb(245 184 61 / 0)' },
        },
        breathe: { '0%, 100%': { opacity: '.45' }, '50%': { opacity: '1' } },
        march: { to: { backgroundPosition: '24px 0' } },
        shake: { '0%, 100%': { transform: 'translateX(0)' }, '20%, 60%': { transform: 'translateX(-2px)' }, '40%, 80%': { transform: 'translateX(2px)' } },
        pop: { '0%': { transform: 'scale(.9)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
      },
      animation: {
        attention: 'attention 1.6s ease-out infinite',
        breathe: 'breathe 1.2s ease-in-out infinite',
        march: 'march 1.4s linear infinite',
        shake: 'shake .4s ease-in-out 2',
        pop: 'pop .4s cubic-bezier(.34,1.56,.64,1)',
      },
    },
  },
} satisfies Config
