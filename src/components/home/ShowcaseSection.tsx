import type { ReactNode } from 'react';
import { useReveal } from './useReveal';
import { Icon, type IconName } from '../icons';
import './ShowcaseSection.css';

interface Props {
  icon: IconName;
  title: string;
  tagline: string;
  copy: string;
  bullets?: string[];
  reverse?: boolean;
  band?: boolean;          // light-grey full-bleed background band
  panelTitle: string;      // fake window title shown in the panel chrome bar
  children: ReactNode;     // mock panel content
}

export default function ShowcaseSection({ icon, title, tagline, copy, bullets, reverse, band, panelTitle, children }: Props) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className={`showcase-band ${band ? 'grey' : ''}`}>
      <section ref={ref} className={`showcase-section reveal ${reverse ? 'reverse' : ''}`}>
        <div className="showcase-copy">
          <span className="showcase-kicker"><Icon name={icon} size={20} /> {title}</span>
          <h3>{tagline}</h3>
          <p>{copy}</p>
          {bullets && (
            <ul className="showcase-bullets">
              {bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
        </div>
        <div className="showcase-panel">
          <div className="panel-frame">
            <div className="panel-frame-bar">
              <span className="frame-dot red" /><span className="frame-dot yellow" /><span className="frame-dot green" />
              <span className="frame-title">{panelTitle}</span>
            </div>
            <div className="panel-frame-body">{children}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
