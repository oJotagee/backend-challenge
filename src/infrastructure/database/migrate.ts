import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../../mikro-orm.config';

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const orm = await MikroORM.init(config);

if (direction === 'up') await orm.migrator.up();
else await orm.migrator.down();

console.log(`migrations ${direction} ok`);

await orm.close(true);
