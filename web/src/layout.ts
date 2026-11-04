import { create } from 'zustand';

interface Layout {
  sidebarOpen: boolean;
  rightOpen: boolean;
  toggleSidebar(): void;
  toggleRight(): void;
}

const stored = (key: string) => localStorage.getItem(`lonca.layout.${key}`) !== '0';
const remember = (key: string, open: boolean) => localStorage.setItem(`lonca.layout.${key}`, open ? '1' : '0');

// Small windows start with the side panels out of the way.
const roomy = window.innerWidth >= 1000;

export const useLayout = create<Layout>((set) => ({
  sidebarOpen: window.innerWidth >= 720 && stored('sidebar'),
  rightOpen: roomy && stored('right'),
  toggleSidebar: () => set((layout) => {
    remember('sidebar', !layout.sidebarOpen);
    return { sidebarOpen: !layout.sidebarOpen };
  }),
  toggleRight: () => set((layout) => {
    remember('right', !layout.rightOpen);
    return { rightOpen: !layout.rightOpen };
  }),
}));
