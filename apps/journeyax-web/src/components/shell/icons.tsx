import type { SVGProps } from 'react';

/**
 * Small line icons for the shell, drawn here (own artwork, one stroke style). Decorative by default: put the label on the
 * button, not the icon.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SidebarIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15" /></Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const NewChatIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 20.5a8.5 8.5 0 1 1 8.5-8.5c0 1.6-.45 3.1-1.2 4.4l.7 3.6-3.7-.7a8.4 8.4 0 0 1-4.3 1.2Z" /><path d="M12 8.5v7M8.5 12h7" /></Svg>
);
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></Svg>
);
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}><path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1.2-4.3A8.5 8.5 0 1 1 20.5 12Z" /></Svg>
);
export const CustomizeIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" /></Svg>
);
export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}><path d="m6 9.5 6 6 6-6" /></Svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>
);
export const ArrowUpIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.1}><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></Svg>
);
export const StopIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" /></Svg>
);
export const BagIcon = (p: IconProps) => (
  <Svg {...p}><path d="M6 8h12l-1 12H7L6 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></Svg>
);
export const SignOutIcon = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 20.5h-4a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h4M16 16.5l4.5-4.5L16 7.5M20.5 12h-11" /></Svg>
);
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18" /></Svg>
);
export const AgentIcon = (p: IconProps) => (
  <Svg {...p}><rect x="5" y="8" width="14" height="11" rx="3.5" /><path d="M12 8V4.5M9.5 13.5v1M14.5 13.5v1" /><circle cx="12" cy="4" r="1" /></Svg>
);
export const SkillIcon = (p: IconProps) => (
  <Svg {...p}><path d="M13.5 3.5 5 13.5h6l-1 7 8.5-10h-6l1-7Z" /></Svg>
);
export const BookIcon = (p: IconProps) => (
  <Svg {...p}><path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14.5H6.5A1.5 1.5 0 0 0 5 20V5.5Z" /><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19V18.5" /></Svg>
);
export const PlugIcon = (p: IconProps) => (
  <Svg {...p}><path d="M9 3.5V8M15 3.5V8M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8ZM12 17v3.5" /></Svg>
);
export const CopyIcon = (p: IconProps) => (
  <Svg {...p}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></Svg>
);
export const CheckIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={2}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>
);
export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}><path d="M13.5 4.5h6v6M19.5 4.5 11 13M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" /></Svg>
);
export const UserIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></Svg>
);
export const PanelIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M14.5 4.5v15" /></Svg>
);
