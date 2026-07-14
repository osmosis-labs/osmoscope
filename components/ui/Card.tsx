import { cn } from "@/lib/utils";
import { forwardRef } from "react";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Raise the card above its siblings while hovered. The card's `backdrop-blur`
   * creates a stacking context, so an in-card popover/tooltip (Recharts tooltips,
   * the `?` explainers) that overflows the card bottom is otherwise painted UNDER
   * the next card. A CSS-only `hover:z-30` lifts the whole card exactly while the
   * pointer is over it — which is precisely when a tooltip can show — with no JS
   * hover state. Set this on any card that contains a chart/tooltip.
   */
  liftOnHover?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ children, className, liftOnHover }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg bg-white/10 p-6 backdrop-blur-sm",
          "border border-white/20 shadow-xl",
          liftOnHover && "relative z-0 hover:z-30",
          className
        )}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";

export function CardHeader({ children, className }: CardProps) {
  return <div className={cn("mb-4", className)}>{children}</div>;
}

// `as` lets callers set the heading level for a correct document outline
// (default h3). The tokenomics page passes h2 so it doesn't skip h1 -> h3.
export function CardTitle({
  children,
  className,
  as: Tag = "h3",
}: CardProps & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Tag className={cn("text-xl font-semibold text-white", className)}>
      {children}
    </Tag>
  );
}

export function CardContent({ children, className }: CardProps) {
  return <div className={cn("text-osmo-100", className)}>{children}</div>;
}
