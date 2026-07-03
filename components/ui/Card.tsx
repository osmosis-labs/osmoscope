import { cn } from "@/lib/utils";
import { forwardRef } from "react";

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ children, className }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg bg-white/10 p-6 backdrop-blur-sm",
          "border border-white/20 shadow-xl",
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
