/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#06040b",
        paper: "#ffffff",
        panel: "#100c19",
        panel2: "#332554",
        muted: "#b8b0cf"
      },
      boxShadow: {
        panel: "0 10px 30px rgba(255,255,255,0.05)"
      }
    }
  },
  plugins: []
};
