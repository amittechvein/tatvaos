'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ACCENTS, useTheme as useAppearance, type ColorMode, type RailMode } from '@/lib/theme';

/**
 * The appearance panel.
 *
 * Materio's own customizer is a paid feature; this is ours, and it is
 * deliberately shorter than theirs. Their panel offers right-to-left layout,
 * horizontal navigation, six sidebar variants and photographic backgrounds —
 * options that exist to demonstrate range to someone evaluating a template.
 * Each one is a second layout to keep working forever. These four are the ones
 * a customer will actually touch.
 *
 * The sidebar colour picker is gone since the move to MUI: Materio's rail is
 * the paper surface, so it follows light/dark rather than being coloured
 * separately. Colouring it independently is what made the old design need a
 * separate control.
 */
export function Switcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mode, setMode, accent, setAccent, railMode, setRailMode, reset } = useAppearance();

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: 300 } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                 px: 3, height: 64 }}>
        <Typography variant="h6">Appearance</Typography>
        <IconButton onClick={onClose} size="small" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </IconButton>
      </Box>
      <Divider />

      <Box sx={{ p: 3, overflowY: 'auto' }}>
        <Section label="Mode">
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={mode}
            onChange={(_, v: ColorMode | null) => v && setMode(v)}
          >
            <ToggleButton value="light">Light</ToggleButton>
            <ToggleButton value="dark">Dark</ToggleButton>
          </ToggleButtonGroup>
        </Section>

        <Section label="Accent colour">
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
            {ACCENTS.map((a) => (
              <Box
                key={a.hex}
                component="button"
                onClick={() => setAccent(a.hex)}
                title={a.name}
                aria-label={a.name}
                aria-pressed={accent.toLowerCase() === a.hex.toLowerCase()}
                sx={{
                  width: 34, height: 34, borderRadius: '50%', cursor: 'pointer', p: 0,
                  border: 0, bgcolor: a.hex,
                  outline: accent.toLowerCase() === a.hex.toLowerCase()
                    ? '2px solid currentColor' : 'none',
                  outlineOffset: 2,
                  transition: '0.15s',
                  '&:hover': { transform: 'scale(1.08)' },
                }}
              />
            ))}
          </Box>

          {/* Native colour input: keyboard accessible, works on touch, and
              remembers recent choices — none of which a bespoke picker gets
              for free. */}
          <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
            <Box
              component="input"
              type="color"
              value={accent}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccent(e.target.value)}
              aria-label="Custom accent colour"
              sx={{ width: 38, height: 28, p: 0.25, cursor: 'pointer',
                    border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'transparent' }}
            />
            <Typography variant="caption" color="text.secondary">Pick any colour</Typography>
          </Box>
        </Section>

        <Section label="Sidebar">
          <ToggleButtonGroup
            exclusive
            orientation="vertical"
            fullWidth
            size="small"
            value={railMode}
            onChange={(_, v: RailMode | null) => v && setRailMode(v)}
          >
            <ToggleButton value="expanded">Full</ToggleButton>
            <ToggleButton value="icons">Icons only</ToggleButton>
            <ToggleButton value="hidden">Hidden</ToggleButton>
          </ToggleButtonGroup>
        </Section>

        <Button fullWidth variant="outlined" onClick={reset} sx={{ mt: 1 }}>
          Reset to defaults
        </Button>

        <Typography variant="caption" color="text.disabled"
                    sx={{ display: 'block', mt: 2, lineHeight: 1.6 }}>
          Saved in this browser only. Your organisation&apos;s own branding is a
          separate setting.
        </Typography>
      </Box>
    </Drawer>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 3.5 }}>
      <Typography
        variant="caption"
        sx={{ display: 'block', mb: 1.5, fontWeight: 600, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'text.secondary' }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  );
}
