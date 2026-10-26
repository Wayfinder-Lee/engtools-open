import { useReveal } from './useReveal';
import './PrintMarquee.css';

const PAGES = ['01', '02', '03', '04', '05', '06', '07', '08', '09'];

/** Right-to-left infinite marquee of exported worksheet pages */
export default function PrintMarquee() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section ref={ref} className="print-marquee reveal">
      <h2 className="print-marquee-title">排版整洁美观，随时导出打印</h2>
      <p className="print-marquee-sub">所有学案均按印刷标准排版，一键导出 PDF / Word，直接进课堂</p>
      <div className="marquee-viewport">
        <div className="marquee-track">
          {/* duplicated list → seamless loop */}
          {[...PAGES, ...PAGES].map((p, i) => (
            <img key={i} src={`/landing/showcase/${p}.jpg`} alt={`学案排版示例 ${p}`}
              loading="lazy" draggable={false} />
          ))}
        </div>
      </div>
    </section>
  );
}
