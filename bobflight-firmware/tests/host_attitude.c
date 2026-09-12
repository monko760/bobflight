#include "flight/attitude.h"
#include <math.h>
#include <stdio.h>
#define CHECK(x) do {if(!(x)){fprintf(stderr,"failed line %d\n",__LINE__);return 1;}} while(0)
int main(void){
 float gyro[3]={0},acc[3]={0,0,1},out[3],sticks[4]={0};
 attitude_init();CHECK(!attitude_ready());CHECK(attitude_update(gyro,acc,.001f));
 CHECK(fabsf(attitude_degrees()[0])<.01f);CHECK(fabsf(attitude_degrees()[1])<.01f);
 attitude_init();acc[1]=.5f;acc[2]=.8660254f;CHECK(attitude_update(gyro,acc,.001f));
 CHECK(fabsf(attitude_degrees()[0]-30)<.01f);attitude_setpoint(sticks,out);CHECK(out[0]<-119);
 attitude_init();acc[0]=-.5f;acc[1]=0;CHECK(attitude_update(gyro,acc,.001f));
 CHECK(fabsf(attitude_degrees()[1]-30)<.01f);attitude_setpoint(sticks,out);CHECK(out[1]<-119);
 acc[0]=0;acc[2]=1;for(int i=0;i<5000;i++)CHECK(attitude_update(gyro,acc,.001f));
 CHECK(fabsf(attitude_degrees()[1])<.01f);
 CHECK(!attitude_update(gyro,acc,.1f));CHECK(!attitude_ready());
 gyro[0]=NAN;CHECK(!attitude_update(gyro,acc,.001f));
 puts("PASS: attitude axes, feedback, convergence and invalid input");return 0;
}
