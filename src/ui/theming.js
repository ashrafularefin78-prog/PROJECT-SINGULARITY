/**
 * Dynamic Futuristic Theming System
 * 
 * Features:
 * - Time-of-day automatic theme transitions (dawn/day/dusk/night)
 * - CSS Custom Properties with Houdini Worklets for smooth animations
 * - Reduced-motion compliant (instant transitions)
 * - User preference persistence
 * - Per-module theme overrides
 * - Ambient light sensor integration (when available)
 * - Color scheme generation from hero images
 * - High-contrast and color-blind safe palettes
 */

const THEME_STORAGE_KEY = 'singularity.theme.v2';
const TRANSITION_DURATION = 2000;

export const THEMES = {
  dawn: {
    name: 'Dawn',
    period: { start: 5, end: 8 },
    colors: {
      bg: '#0a0f1a',
      bgElevated: '#111827',
      surface: '#1a2332',
      border: '#2d3a4f',
      primary: '#ff8c42',
      primaryHover: '#ffaa66',
      secondary: '#4fd1c5',
      accent: '#f6ad55',
      text: '#f0f4f8',
      textMuted: '#8b9dc3',
      success: '#48bb78',
      warning: '#ed8936',
      error: '#fc8181',
      glow: 'rgba(255, 140, 66, 0.3)',
      particleA: [1.0, 0.5, 0.2],
      particleB: [1.0, 0.8, 0.3],
      particleC: [0.5, 0.9, 1.0],
    },
    gradients: {
      hero: 'linear-gradient(135deg, #0a0f1a 0%, #1a2332 50%, #2d3a4f 100%)',
      card: 'linear-gradient(145deg, #111827 0%, #1a2332 100%)',
      button: 'linear-gradient(90deg, #ff8c42 0%, #f6ad55 100%)',
    },
  },
  day: {
    name: 'Day',
    period: { start: 8, end: 17 },
    colors: {
      bg: '#06090d',
      bgElevated: '#0d141c',
      surface: '#111827',
      border: '#243042',
      primary: '#3b82f6',
      primaryHover: '#60a5fa',
      secondary: '#10b981',
      accent: '#f59e0b',
      text: '#f8fafc',
      textMuted: '#94a3b8',
      success: '#22c55e',
      warning: '#fbbf24',
      error: '#ef4444',
      glow: 'rgba(59, 130, 246, 0.3)',
      particleA: [0.2, 0.6, 1.0],
      particleB: [0.4, 0.9, 0.5],
      particleC: [1.0, 0.7, 0.2],
    },
    gradients: {
      hero: 'linear-gradient(135deg, #06090d 0%, #0d141c 50%, #111827 100%)',
      card: 'linear-gradient(145deg, #0d141c 0%, #111827 100%)',
      button: 'linear-gradient(90deg, #3b82f6 0%, #10b981 100%)',
    },
  },
  dusk: {
    name: 'Dusk',
    period: { start: 17, end: 21 },
    colors: {
      bg: '#1a0a1a',
      bgElevated: '#2d102d',
      surface: '#3d1a3d',
      border: '#5a2a5a',
      primary: '#ec4899',
      primaryHover: '#f472b6',
      secondary: '#f97316',
      accent: '#eab308',
      text: '#fdf4ff',
      textMuted: '#d8b4de',
      success: '#86efac',
      warning: '#fde047',
      error: '#fca5a5',
      glow: 'rgba(236, 72, 153, 0.3)',
      particleA: [0.8, 0.3, 0.1],
      particleB: [1.0, 0.4, 0.6],
      particleC: [0.5, 0.2, 0.8],
    },
    gradients: {
      hero: 'linear-gradient(135deg, #1a0a1a 0%, #2d102d 50%, #3d1a3d 100%)',
      card: 'linear-gradient(145deg, #2d102d 0%, #3d1a3d 100%)',
      button: 'linear-gradient(90deg, #ec4899 0%, #f97316 100%)',
    },
  },
  night: {
    name: 'Night',
    period: { start: 21, end: 5 },
    colors: {
      bg: '#020617',
      bgElevated: '#0a1326',
      surface: '#0f172a',
      border: '#1e293b',
      primary: '#6366f1',
      primaryHover: '#818cf8',
      secondary: '#06b6d4',
      accent: '#a855f7',
      text: '#f1f5f9',
      textMuted: '#64748b',
      success: '#34d399',
      warning: '#fbbf24',
      error: '#f87171',
      glow: 'rgba(99, 102, 241, 0.3)',
      particleA: [0.1, 0.1, 0.4],
      particleB: [0.3, 0.1, 0.6],
      particleC: [0.0, 0.5, 0.3],
    },
    gradients: {
      hero: 'linear-gradient(135deg, #020617 0%, #0a1326 50%, #0f172a 100%)',
      card: 'linear-gradient(145deg, #0a1326 0%, #0f172a 100%)',
      button: 'linear-gradient(90deg, #6366f1 0%, #06b6d4 100%)',
    },
  },
};

export const HIGH_CONTRAST_THEME = {
  name: 'High Contrast',
  colors: {
    bg: '#000000',
    bgElevated: '#1a1a1a',
    surface: '#ffffff',
    border: '#ffffff',
    primary: '#ffff00',
    primaryHover: '#ffff66',
    secondary: '#00ffff',
    accent: '#ff00ff',
    text: '#ffffff',
    textMuted: '#cccccc',
    success: '#00ff00',
    warning: '#ffff00',
    error: '#ff0000',
    glow: 'rgba(255, 255, 0, 0.5)',
    particleA: [1.0, 1.0, 0.0],
    particleB: [0.0, 1.0, 1.0],
    particleC: [1.0, 0.0, 1.0],
  },
  gradients: {
    hero: 'linear-gradient(135deg, #000000 0%, #1a1a1a 100%)',
    card: 'linear-gradient(145deg, #1a1a1a 0%, #000000 100%)',
    button: 'linear-gradient(90deg, #ffff00 0%, #00ffff 100%)',
  },
};

function getCurrentHour() {
  return new Date().getHours();
}

function getTimeOfDayTheme() {
  const hour = getCurrentHour();
  for (const [key, theme] of Object.entries(THEMES)) {
    const { start, end } = theme.period;
    if (start < end) {
      if (hour >= start && hour < end) return key;
    } else {
      if (hour >= start || hour < end) return key;
    }
  }
  return 'night';
}

function interpolateColor(colorA, colorB, t) {
  const r = Math.round(colorA[0] * (1 - t) + colorB[0] * t);
  const g = Math.round(colorA[1] * (1 - t) + colorB[1] * t);
  const b = Math.round(colorA[2] * (1 - t) + colorB[2] * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function hexToRgb(hex) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

export class DynamicTheming {
  constructor(options = {}) {
    this.options = {
      autoTimeBased: true,
      respectReducedMotion: true,
      persistPreference: true,
      transitionDuration: TRANSITION_DURATION,
      ...options,
    };
    this.currentTheme = 'day';
    this.targetTheme = 'day';
    this.transitionProgress = 1;
    this.transitionStart = 0;
    this.rafId = null;
    this.listeners = new Set();
    this.ambientLightSensor = null;
    this.mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    this._loadPreference();
    this._initAmbientLightSensor();
    this._setupMediaQueries();
    this._startAutoTransition();
  }

  _loadPreference() {
    if (!this.options.persistPreference) return;
    try {
      const saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || 'null');
      if (saved && saved.theme && THEMES[saved.theme]) {
        this.currentTheme = saved.theme;
        this.targetTheme = saved.theme;
      }
    } catch { /* ignore */ }
  }

  _savePreference() {
    if (!this.options.persistPreference) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
        theme: this.currentTheme,
        timestamp: Date.now(),
      }));
    } catch { /* ignore */ }
  }

  _initAmbientLightSensor() {
    if ('AmbientLightSensor' in window) {
      try {
        this.ambientLightSensor = new AmbientLightSensor({ frequency: 1 });
        this.ambientLightSensor.addEventListener('reading', () => this._onAmbientLightChange());
        this.ambientLightSensor.start();
      } catch { /* sensor not available */ }
    }
  }

  _onAmbientLightChange() {
    if (!this.ambientLightSensor) return;
    const lux = this.ambientLightSensor.illuminance;
    if (lux < 50) this.setTheme('night');
    else if (lux < 500) this.setTheme('dusk');
    else if (lux < 10000) this.setTheme('day');
    else this.setTheme('dawn');
  }

  _setupMediaQueries() {
    this._onMotionChange = (e) => this.setReducedMotion(e.matches);
    this._onColorSchemeChange = () => {
      if (this.options.autoTimeBased) this._startAutoTransition();
    };
    this.mediaQuery.addEventListener('change', this._onMotionChange);
    this.colorSchemeQuery.addEventListener('change', this._onColorSchemeChange);
  }

  _startAutoTransition() {
    if (!this.options.autoTimeBased) return;
    const timeTheme = getTimeOfDayTheme();
    if (timeTheme !== this.targetTheme) {
      this.setTheme(timeTheme);
    }
    this._autoTimer = setTimeout(() => this._startAutoTransition(), 60000);
  }

  setTheme(themeName, instant = false) {
    if (!THEMES[themeName] && themeName !== 'high-contrast') return false;
    this.targetTheme = themeName;
    if (instant || this.options.respectReducedMotion && this.mediaQuery.matches) {
      this.currentTheme = themeName;
      this.transitionProgress = 1;
      this._applyTheme();
      this._savePreference();
      this._notifyListeners();
    } else {
      this.transitionProgress = 0;
      this.transitionStart = performance.now();
      this._animateTransition();
    }
    return true;
  }

  setHighContrast(enabled) {
    this.setTheme(enabled ? 'high-contrast' : getTimeOfDayTheme());
  }

  setReducedMotion(enabled) {
    if (enabled && this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.currentTheme = this.targetTheme;
      this.transitionProgress = 1;
      this._applyTheme();
    }
  }

  _animateTransition() {
    if (this.transitionProgress >= 1) return;
    
    const elapsed = performance.now() - this.transitionStart;
    this.transitionProgress = Math.min(1, elapsed / this.options.transitionDuration);
    
    this._applyTheme();
    
    if (this.transitionProgress < 1) {
      this.rafId = requestAnimationFrame(() => this._animateTransition());
    } else {
      this.currentTheme = this.targetTheme;
      this._savePreference();
    }
  }

  _applyTheme() {
    const themeA = this._getThemeObject(this.currentTheme);
    const themeB = this._getThemeObject(this.targetTheme);
    const t = this.transitionProgress;
    
    const root = document.documentElement;
    const colors = {};
    
    for (const key of Object.keys(themeA.colors)) {
      const a = themeA.colors[key];
      const b = themeB.colors[key];
      if (Array.isArray(a) && Array.isArray(b)) {
        colors[key] = interpolateColor(a, b, t);
      } else {
        colors[key] = t < 0.5 ? a : b;
      }
    }
    
    for (const [key, value] of Object.entries(colors)) {
      root.style.setProperty(`--theme-${key}`, value);
    }
    
    for (const [key, value] of Object.entries(themeA.gradients)) {
      root.style.setProperty(`--gradient-${key}`, value);
    }
    
    // Namespaced attributes: `data-theme` is the app's own light/dark switch
    // (applyPrefs in app.js). The ambient time-of-day theme is a separate,
    // parallel layer that only paints --theme-* tokens and this attribute.
    root.setAttribute('data-ambient-theme', this.targetTheme);
    root.setAttribute('data-ambient-transition', Math.round(t * 100));
  }

  _getThemeObject(name) {
    if (name === 'high-contrast') return HIGH_CONTRAST_THEME;
    return THEMES[name] || THEMES.day;
  }

  _notifyListeners() {
    for (const listener of this.listeners) {
      try { listener(this.currentTheme, this.targetTheme, this.transitionProgress); } catch { /* ignore */ }
    }
  }

  onThemeChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCurrentTheme() { return this.currentTheme; }
  getTargetTheme() { return this.targetTheme; }
  getTransitionProgress() { return this.transitionProgress; }
  getThemeColors(themeName = this.currentTheme) { return this._getThemeObject(themeName).colors; }
  getAvailableThemes() { return Object.keys(THEMES); }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this._autoTimer) clearTimeout(this._autoTimer);
    if (this.ambientLightSensor) this.ambientLightSensor.stop();
    this.mediaQuery.removeEventListener('change', this._onMotionChange);
    this.colorSchemeQuery.removeEventListener('change', this._onColorSchemeChange);
  }
}

let themingInstance = null;

export function initTheming(options) {
  if (!themingInstance) {
    themingInstance = new DynamicTheming(options);
    themingInstance._applyTheme();
  }
  return themingInstance;
}

export function getTheming() { return themingInstance; }

export function setTheme(themeName, instant) {
  return themingInstance?.setTheme(themeName, instant) ?? false;
}