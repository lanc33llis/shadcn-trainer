import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

import { siteConfig } from "@/lib/config"

export const LOCAL_APP_URL = "http://localhost:4000"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.NODE_ENV === "development" ? LOCAL_APP_URL : siteConfig.url)
  )
}

export function absoluteUrl(path: string) {
  return new URL(path, getAppUrl()).toString()
}
