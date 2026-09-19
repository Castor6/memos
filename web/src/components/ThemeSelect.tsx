import { Monitor, Moon, Palette, Sun } from "lucide-react";
import type { ReactElement } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTranslate } from "@/utils/i18n";
import { loadTheme, THEME_OPTIONS } from "@/utils/theme";

interface ThemeSelectProps {
  value?: string;
  onValueChange?: (theme: string) => void;
  className?: string;
  compact?: boolean;
}

const THEME_ICONS: Record<string, ReactElement> = {
  system: <Monitor className="w-4 h-4" />,
  default: <Sun className="w-4 h-4" />,
  "default-dark": <Moon className="w-4 h-4" />,
  paper: <Palette className="w-4 h-4" />,
  cream: <Palette className="w-4 h-4" />,
  mint: <Palette className="w-4 h-4" />,
  flomo: <Palette className="w-4 h-4" />,
};

const ThemeSelect = ({ value, onValueChange, className, compact = false }: ThemeSelectProps = {}) => {
  const t = useTranslate();
  const options = THEME_OPTIONS.map((option) => ({
    ...option,
    label: t(`setting.preference.themes.${option.value}`),
  }));
  const currentTheme = value || "system";
  const triggerLabel = options.find((option) => option.value === currentTheme)?.label;

  const handleThemeChange = (newTheme: string) => {
    // Apply theme globally immediately
    loadTheme(newTheme);
    // Also notify parent component if callback is provided
    if (onValueChange) {
      onValueChange(newTheme);
    }
  };

  return (
    <Select value={currentTheme} items={options} onValueChange={handleThemeChange}>
      <SelectTrigger className={className}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {compact && THEME_ICONS[currentTheme]}
          {compact ? <span className="truncate">{triggerLabel}</span> : <SelectValue className="truncate" placeholder="Select theme" />}
        </div>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <div className="flex items-center gap-2">
              {THEME_ICONS[option.value]}
              <span>{option.label}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export default ThemeSelect;
