'use client'

import { createContext, useContext, useState, ReactNode } from 'react'

interface SidebarContextValue {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  messagesUnreadCount: number
  setMessagesUnreadCount: (count: number) => void
}

const SidebarContext = createContext<SidebarContextValue>({
  sidebarCollapsed: false,
  setSidebarCollapsed: () => {},
  messagesUnreadCount: 0,
  setMessagesUnreadCount: () => {},
})

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [messagesUnreadCount, setMessagesUnreadCount] = useState(0)
  return (
    <SidebarContext.Provider value={{ sidebarCollapsed, setSidebarCollapsed, messagesUnreadCount, setMessagesUnreadCount }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebarCollapsed() {
  return useContext(SidebarContext)
}
