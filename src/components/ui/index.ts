/**
 * Fluent 2 UI primitives — the shared control layer built on the `.ui-*` CSS
 * in `src/styles.css`. New screens use these instead of re-deriving buttons,
 * selects and toggles per feature (see docs/design/fluent-design.md).
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { IconButton, type IconButtonProps } from "./IconButton";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { Switch, type SwitchProps } from "./Switch";
export { Tabs, type TabsItem, type TabsProps } from "./Tabs";
export { Menu, type MenuItemSpec, type MenuProps, type MenuAnchor, type MenuCloseReason } from "./Menu";
export { Input, SearchBox, Textarea, type InputProps, type SearchBoxProps, type TextareaProps } from "./Input";
export {
  ViewPaneContainer,
  SectionHeader,
  ActionBar,
  type ViewPaneDescriptor,
  type SectionHeaderProps,
  type PaneAction,
} from "./ViewPane";
