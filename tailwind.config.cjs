/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: { ...require('./tokens/tailwind.tokens.cjs') },
  },
  plugins: [],
};
