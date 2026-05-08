import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Color tokens — papers/ui-guidance.md §1
      colors: {
        primary: {
          DEFAULT: '#2B579A',
          light: '#5B9BD5',
          dark: '#1E3F6F',
        },
        accent: '#ED7D31',
        success: '#2E8B57',
        danger: '#DC3545',
        surface: '#FFFFFF',
        background: '#F8FAFC',
        text: {
          DEFAULT: '#333333',
          muted: '#999999',
        },
      },
      // Typography — papers/ui-guidance.md §2
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [typography],
}
