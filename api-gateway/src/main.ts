import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // app.setGlobalPrefix('api/v1');
  // global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      //If you're spreading the body object anywhere, or if your service doesn't explicitly map fields,
      // that role: "ADMIN" could make it into the DB. This is called mass assignment vulnerability — it's how
      // several real-world security breaches have happened.
      // To prevent we use whitelist which strip off unknown properties
      whitelist: true, // strip fields not in DTO
      forbidNonWhitelisted: true, // throw error if unknown fields is set
      transform: true, //auto-transform the payloads to dto instances
    }),
  );

  // swagger setup
  const config = new DocumentBuilder()
    .setTitle('Wavelink api')
    .setDescription('Chat application API')
    .setVersion('1.0.0')
    .addBearerAuth() // add auth button in swagger api
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
  await app.listen(process.env.PORT ?? 3000); // always at last
}
bootstrap();
