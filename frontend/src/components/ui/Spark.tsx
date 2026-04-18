interface SparkProps {
  data: number[];
  stroke?: string;
  height?: number;
  width?: number;
  fill?: boolean;
}

export function Spark({ data, stroke = 'var(--lb-accent)', height = 32, width = 120, fill = false }: SparkProps) {
  if (!data || data.length < 2) {
    return <svg width={width} height={height} style={{ display: 'block' }} />;
  }
  const max = Math.max(...data), min = Math.min(...data);
  const step = width / (data.length - 1);
  const pts = data.map((v, i) =>
    `${(i * step).toFixed(2)},${(height - ((v - min) / (max - min || 1)) * (height - 4) - 2).toFixed(2)}`
  );
  const path = `M${pts.join(' L')}`;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {fill && <path d={`${path} L${width},${height} L0,${height} Z`} fill={stroke} opacity={0.08} />}
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
