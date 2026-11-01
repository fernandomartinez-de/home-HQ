import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Home",
    short_name: "Home",
    description: "Water heater, AC and lights in one place.",
    start_url: "/",
    display: "standalone",
    background_color: "#1d1b19",
    theme_color: "#1d1b19",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
