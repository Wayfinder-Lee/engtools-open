import type { Stage } from '../types';

/**
 * 示例语料（W3 新手激活包）：原创的高考/中考风格文本，让新教师
 * 「用示例试一试」零成本看到成品。均为本站自写，非真题原文。
 */

/** 词汇提取 · 高考风格（含题型标题，便于自动分段） */
export const SAMPLE_VOCAB_SENIOR = `第二部分 阅读理解
A
Volunteer Opportunities at Riverside Nature Center
Are you interested in wildlife and outdoor education? Riverside Nature Center is looking for weekend volunteers to help with our autumn programs. Duties include guiding small groups of visitors along the forest trails, preparing materials for children's workshops, and recording bird sightings in the wetland area. Volunteers must be able to walk three miles on uneven paths and attend a half-day training session. All training is provided free of charge. High school students aged 16 and above are welcome, and community service certificates will be issued upon completion of 20 hours. To apply, email your name, available dates, and a short self-introduction to volunteer@riversidenc.org before September 30th.

B
When my family moved to a small coastal town, I expected long, boring summers. Instead, I discovered the local surfing club, where an elderly coach named Mr. Hayes taught kids like me for free. He insisted that we learn to read the waves before touching a board. "The ocean tells you everything," he repeated, watching the horizon through weathered eyes. At first his lessons seemed endless — we sat on the sand for hours, observing tides and wind direction. Gradually, I began to understand what he meant. By August I could predict when a good wave would arrive, and my first successful ride felt like flying. Mr. Hayes never praised us loudly, but the quiet nod he gave me that day remains my proudest memory.

第三部分 语言运用
第一节 完形填空
Last winter, our school started a "no-phone lunch" experiment. At first, most students ___ (1) strongly. We argued that checking messages was a basic freedom. The teachers, however, had ___ (2) a sharp rise in loneliness during lunch breaks — everyone sat together but stared at separate screens. For the first week, the cafeteria felt strangely ___ (3). Then something unexpected happened. With nothing to scroll through, we began actually talking. My classmates and I ___ (4) board games, shared snacks, and even started a lunchtime book club. By the end of the month, the school survey showed that students felt more ___ (5) to their classmates. Looking back, giving up our phones for forty minutes was a small price to pay for genuine ___ (6).`;

/** 词汇提取 · 中考风格 */
export const SAMPLE_VOCAB_JUNIOR = `二、阅读理解
A
Welcome to the City Children's Library
Our library is open from 9:00 a.m. to 6:00 p.m. on weekdays and from 10:00 a.m. to 4:00 p.m. at weekends. Children under 12 must come with an adult. You can borrow up to five books at a time and keep them for three weeks. This month, we have two fun activities: a picture-book reading hour every Saturday morning, and a "little scientist" experiment class on Sunday afternoon. Both activities are free, but you need to sign up at the front desk because seats are limited. Please keep quiet in the reading area, and remember to return your books on time so other children can enjoy them too.

三、完形填空
Last month, our class had a special homework: plant a vegetable and watch it grow. I chose a small tomato plant and put it on my balcony. Every morning I checked the ___ (1) to make sure the soil was wet. At first, nothing seemed to happen, and I almost gave up. My grandmother told me, "Plants grow ___ (2), but they never stop." Two weeks later, a tiny green leaf appeared. I was so ___ (3) that I took photos of it every day. In May, the plant produced small yellow flowers, and soon I found three green tomatoes. When they finally turned red, I picked them and shared them with my family. They tasted much better than the ones from the supermarket, because I had grown them with my own ___ (4).`;

/** 应用文助手 · 高中题干（邀请信） */
export const SAMPLE_PRACTICAL_SENIOR = `假定你是李华，你校下个月将举办「中国传统美食文化节」。请写邮件邀请你校英国外教 Mr. Smith 参加活动，内容包括：
1. 活动时间与地点；
2. 活动内容（包饺子、茶艺展示等）；
3. 表达期待。
注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。`;

/** 应用文助手 · 初中题干（书面表达） */
export const SAMPLE_PRACTICAL_JUNIOR = `假如你是李华，你的美国朋友 Tom 下周要来你所在的城市游玩一天。请根据以下提示用英语给他写一封电子邮件，告诉他你的安排：
1. 上午参观博物馆；
2. 中午品尝本地小吃；
3. 下午去公园划船。
注意：1. 词数 80-100；2. 可以适当增加细节，以使行文连贯。`;

/** 读后续写 · 前文（含两段续写首句） */
export const SAMPLE_CONTINUATION = `Every Saturday morning, Maya raced her old blue bicycle down Miller's Hill to deliver fresh bread from her grandmother's bakery. It was a routine she loved — the warm paper bags, the smell of cinnamon, and Mr. Alvarez on Maple Street who always waved from his garden. But this Saturday, as she sped down the familiar slope, the rear wheel wobbled, then locked completely. Maya flew over the handlebars and landed hard on the grass, bread scattered everywhere. Her knee was bleeding, her wrist hurt badly, and the bicycle — her grandmother's gift — lay twisted under a hedge. Worst of all, she still had fifteen houses to deliver, and Grandmother's customers were counting on their Sunday breakfast. Maya sat on the grass, fighting back tears, when she heard footsteps coming up the hill.

Paragraph 1: Looking up, she saw Mr. Alvarez hurrying towards her with a first-aid kit in his hand.

Paragraph 2: By noon, the last paper bag was delivered, and Maya pedalled slowly back to the bakery.`;

/** 衡水体字帖 · 示例内容 */
export const SAMPLE_COPYBOOK = `Where there is a will, there is a way.
Practice makes perfect.
Every cloud has a silver lining.
A journey of a thousand miles begins with a single step.
The early bird catches the worm.
Actions speak louder than words.
Knowledge is power.
Never put off until tomorrow what you can do today.`;

/** 应用文体裁模板（W3）：点选即填，可再编辑。 */
export const PRACTICAL_TEMPLATES: { label: string; text: string }[] = [
  {
    label: '建议信',
    text: `假定你是李华，你的英国朋友 Jim 最近因学业压力大而情绪低落。请你给他写一封回信，内容包括：
1. 表示理解与安慰；
2. 提出两条具体建议（如锻炼、倾诉等）；
3. 表达鼓励与祝愿。
注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。`,
  },
  {
    label: '邀请信',
    text: `假定你是李华，你校将举办英语演讲比赛，主题为「科技改变生活」。请写邮件邀请外教 Ms. Brown 担任评委，内容包括：
1. 比赛时间与地点；
2. 评委职责；
3. 表达期待。
注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。`,
  },
  {
    label: '申请信',
    text: `假定你是李华，看到学校国际文化交流节招募学生志愿者。请写一封申请信，内容包括：
1. 申请意愿与自身优势（英语口语、组织经验等）；
2. 可以承担的工作；
3. 希望获得批准。
注意：1. 词数 100 左右；2. 可以适当增加细节，以使行文连贯。`,
  },
  {
    label: '通知',
    text: `你校将邀请外籍专家 Dr. White 做一场关于英国文化的讲座。请以学生会名义用英语写一则通知，内容包括：
1. 讲座主题、时间与地点；
2. 讲座主要内容；
3. 报名方式与截止时间。
注意：1. 词数 100 左右；2. 格式规范，要点清晰。`,
  },
];

/** 按学段返回应用文示例题干 */
export function practicalSample(stage: Stage): string {
  return stage === 'junior' ? SAMPLE_PRACTICAL_JUNIOR : SAMPLE_PRACTICAL_SENIOR;
}
