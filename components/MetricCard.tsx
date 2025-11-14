import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface MetricCardProps {
  title: string;
  value?: string;
  subtitle?: string;
  trend?: {
    value: number;
    label: string;
  };
  chart?: ReactNode;
  chartOnly?: boolean;
  className?: string;
}

export function MetricCard({
  title,
  value,
  subtitle,
  trend,
  chart,
  chartOnly = false,
  className,
}: MetricCardProps) {
  const isPositive = trend && trend.value > 0;
  const isNegative = trend && trend.value < 0;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-osmo-200">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartOnly ? (
          <div className="w-full">{chart}</div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="text-3xl font-bold text-white">{value}</div>
              {subtitle && (
                <div className="mt-1 text-sm text-osmo-100">{subtitle}</div>
              )}
              {trend && (
                <div
                  className={cn(
                    "mt-2 flex items-center text-sm font-medium",
                    isPositive && "text-green-400",
                    isNegative && "text-red-400",
                    !isPositive && !isNegative && "text-osmo-100"
                  )}
                >
                  {isPositive && "↑"}
                  {isNegative && "↓"}
                  <span className="ml-1">
                    {Math.abs(trend.value).toFixed(1)}% {trend.label}
                  </span>
                </div>
              )}
            </div>
            {chart && <div className="ml-4">{chart}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
