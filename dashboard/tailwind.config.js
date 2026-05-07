/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        mb: {
          bg:         "#0C1E35",
          surface:    "#1A2942",
          accent:     "#60A5FA",
          secondary:  "#34D399",
          warning:    "#FBBF24",
          error:      "#F87171",
          textPrimary:   "#E0F2FE",
          textSecondary: "#7DD3FC",
        },
      },
    },
  },
  plugins: [],
};
